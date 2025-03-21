import {
  AnyThreadChannel,
  CategoryChannel,
  Channel,
  ChannelType,
  Collection,
  CommandInteraction,
  FetchedThreads,
  FetchedThreadsMore,
  ForumChannel,
  GuildBasedChannel,
  GuildMember,
  MediaChannel,
  MessageFlagsBitField,
  NewsChannel,
  PermissionFlagsBits,
  PrivateThreadChannel,
  PublicThreadChannel,
  TextChannel,
  ThreadChannel,
  ThreadMember,
} from "discord.js";
import { logger } from "../index";
import { ChannelData } from "../interfaces/database";
import { ThreadBumpResult, WatchedThread } from "../interfaces/thread";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { EmbedBuilderFunction } from "./embedUtils";
import { reportError } from "./errorReporter";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import { StatusType } from "./logger";
import { rateLimitManager } from "./rateLimitManager";

// IMPORTANT: Don't access client at module level - moved inside functions
// Add tracking for problematic threads to avoid repeated failures
// Change from Map to Collection
export const problemThreads = new Collection<
  string,
  {
    failCount: number;
    lastTried: number;
    methods: string[];
  }
>();

// Maximum number of bump attempts before switching to alternative strategy
export const MAX_BUMP_ATTEMPTS = 3;

/**
 *
 * @param dueArchive the amount of time a thread has to be inactive for discord to hide it, in minutes
 * @param fromDate from what timestamp to calculate when thread will be hidden
 * @returns {Number} the calculated timestamp where a thread will be hidden
 */
export function dueArchiveTimestamp(dueArchive: number, fromDate?: Date): number {
  let date = fromDate || new Date();
  if (fromDate && !(fromDate instanceof Date)) {
    date = new Date(0);
  }

  return date.getTime() / 1000 + dueArchive * 60;
}

/**
 * Track thread bump attempts to identify problematic threads
 */
export function trackBumpAttempt(threadId: string, success: boolean, method?: string): void {
  // Get existing stats or create default object if not exists - leveraging Collection methods
  const stats = problemThreads.ensure(threadId, () => ({
    failCount: 0,
    lastTried: Date.now(),
    methods: [],
  }));

  if (!success) {
    stats.failCount++;
  } else if (stats.failCount > 0) {
    // Reduce fail count but don't go below 0
    stats.failCount = Math.max(0, stats.failCount - 1);
  }

  stats.lastTried = Date.now();
  if (method) {
    stats.methods.push(method);
    // Keep only the last 5 methods
    if (stats.methods.length > 5) {
      stats.methods.shift();
    }
  }

  if (stats.failCount >= MAX_BUMP_ATTEMPTS) {
    logger.warn(
      `Thread ${threadId} has failed ${stats.failCount} bump attempts and is now marked as problematic`
    );
  }
}

/**
 * Special handler for threads that have repeatedly failed standard bump attempts
 * Uses different approaches that don't rely on thread.manageable being true
 */
export async function handleProblemThread(thread: ThreadChannel): Promise<ThreadBumpResult> {
  const result: ThreadBumpResult = {
    success: false,
    message: "Alternative approach failed for problematic thread",
  };

  try {
    logger.info(`Using alternative maintenance for problematic thread ${thread.id}`);

    // Get client only when needed
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
      return {
        success: false,
        message: "Client not available yet",
      };
    }
    const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);

    // Approach 1: Try sending a message even if sendable is false
    try {
      await client.rest.post(`/channels/${thread.id}/messages`, {
        body: {
          content: "Thread Watcher is maintaining this problematic thread.",
        },
      });

      logger.info(`Successfully maintained problematic thread ${thread.id} with message`);
      result.success = true;
      result.method = "problematic-direct-message";
      result.message = "Thread maintained via direct message API";
      return result;
    } catch (msgErr) {
      logger.debug(`Could not send message to problematic thread ${thread.id}: ${msgErr}`);
    }

    // Approach 2: Try toggling archived state using direct API calls
    try {
      const isArchived = thread.archived;

      // Toggle archived state
      await client.rest.patch(`/channels/${thread.id}`, {
        body: { archived: !isArchived },
      });

      // Wait briefly
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Toggle back if needed
      if (!isArchived) {
        await client.rest.patch(`/channels/${thread.id}`, {
          body: { archived: false },
        });
      }

      logger.info(
        `Successfully maintained problematic thread ${thread.id} by toggling archive state`
      );
      result.success = true;
      result.method = "problematic-toggle-archive";
      result.message = "Thread maintained via archive state toggling";
      return result;
    } catch (archiveErr) {
      logger.debug(
        `Could not toggle archive state for problematic thread ${thread.id}: ${archiveErr}`
      );
    }

    return result;
  } catch (err) {
    logger.error(`Alternative approach failed for problematic thread ${thread.id}: ${err}`);
    return result;
  }
}

/**
 * Try to modify a thread using its parent's specialized thread manager
 * This bypasses Discord's inconsistent permission checks by using the proper manager
 */
export async function manipulateViaParentManager(
  thread: ThreadChannel,
  operation: "unarchive" | "setAutoArchiveDuration",
  value?: number
): Promise<boolean> {
  if (!thread.parent) {
    logger.debug(`Thread ${thread.id} has no accessible parent channel`);
    return false;
  }

  try {
    const parentChannel = thread.parent;
    logger.debug(
      `Using parent channel ${parentChannel.name} (${parentChannel.id}) thread manager for thread ${thread.id}`
    );

    // This will use the proper specialized thread manager based on the parent's type
    const threadManager = parentChannel.threads;

    if (operation === "unarchive") {
      if (thread.archived) {
        // Fetch the thread through the parent's thread manager and then edit it
        const fetchedThread = await threadManager.fetch(thread.id);
        if (fetchedThread) {
          await fetchedThread.setArchived(false);
          logger.info(`Thread ${thread.id} unarchived via parent's thread manager`);
          return true;
        } else {
          logger.debug(`Could not fetch thread ${thread.id} via parent's thread manager`);
          return false;
        }
      }
      return false;
    } else if (operation === "setAutoArchiveDuration" && value) {
      // Fetch the thread through the parent's thread manager and then edit it
      const fetchedThread = await threadManager.fetch(thread.id);
      if (fetchedThread) {
        await fetchedThread.setAutoArchiveDuration(value);
        logger.info(
          `Thread ${thread.id} auto-archive duration set to ${value} via parent's thread manager`
        );
        return true;
      }
      logger.debug(`Could not fetch thread ${thread.id} via parent's thread manager`);
      return false;
    }

    return false;
  } catch (err) {
    logger.debug(`Failed to manipulate thread ${thread.id} via parent's thread manager: ${err}`);
    return false;
  }
}

/**
 * Check if a thread seems to be in an inconsistent permission state
 * where normal operations might fail
 */
export function hasPermissionInconsistency(thread: ThreadChannel): boolean {
  // Only process threads, not other channel types
  if (!thread || !thread.isThread()) return false;

  try {
    // Get basic permission data
    const botThreadMember = thread.members.me;

    // Basic inconsistency checks
    const simpleInconsistency =
      // Joined but can't manage/send (which is definitely an inconsistency)
      thread.joined &&
      (!thread.manageable || !thread.sendable) &&
      !thread.locked &&
      !thread.archived;

    // Discord.js inconsistency where joined=true but no member object
    const memberInconsistency =
      thread.joined && !botThreadMember && !thread.locked && !thread.archived;

    return simpleInconsistency || memberInconsistency;
  } catch {
    // On error, assume this might be an inconsistency if the thread is not locked/archived
    return !thread.locked && !thread.archived;
  }
}

/**
 * Union type representing any channel that can directly contain threads
 */
export type ThreadCapableChannel = TextChannel | NewsChannel | ForumChannel | MediaChannel;

/**
 * Constant array of channel types that can contain threads
 * Use as const for better type inference with spread operator
 */
export const THREAD_CAPABLE_CHANNEL_TYPES = [
  ChannelType.GuildText, // 0
  ChannelType.GuildAnnouncement, // 5
  ChannelType.GuildForum, // 15
  ChannelType.GuildMedia, // 16
] as const;

/**
 * Constant array of channel types that are threads themselves
 */
export const THREAD_CHANNEL_TYPES = [
  ChannelType.PublicThread, // 11
  ChannelType.PrivateThread, // 12
  ChannelType.AnnouncementThread, // 10
] as const;

/**
 * All channel types that are relevant to thread operations
 * Includes containers, threads, and categories
 */
export const THREAD_RELATED_CHANNEL_TYPES = [
  ...THREAD_CAPABLE_CHANNEL_TYPES,
  ...THREAD_CHANNEL_TYPES,
  ChannelType.GuildCategory, // 4
] as const;

/**
 * Type guard to check if a channel can contain threads
 */
export function isThreadCapableChannel(
  channel: GuildBasedChannel
): channel is ThreadCapableChannel {
  return THREAD_CAPABLE_CHANNEL_TYPES.includes(
    channel.type as (typeof THREAD_CAPABLE_CHANNEL_TYPES)[number]
  );
}

/**
 * Type guard to check if a channel is a thread
 */
export function isThreadChannel(
  channel: Channel | ThreadChannel | null | undefined
): channel is PublicThreadChannel<boolean> | PrivateThreadChannel | AnyThreadChannel {
  if (!channel) return false;
  return THREAD_CHANNEL_TYPES.includes(channel.type as (typeof THREAD_CHANNEL_TYPES)[number]);
}

/**
 * Fetch a thread channel with error handling and proper permission loading
 * @param threadId The ID of the thread to fetch
 * @returns The thread channel or null if not found/invalid
 */
export async function fetchThreadChannel(threadId: string): Promise<ThreadChannel | null> {
  if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
    logger.debug(`Client not available when trying to fetch thread ${threadId}`);
    return null;
  }

  const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);

  try {
    // First try to fetch directly
    let thread = (await client.channels.fetch(threadId, { force: true })) as ThreadChannel;

    if (!thread || !isThreadChannel(thread)) {
      return null;
    }

    // If the thread has a parent channel, fetch it through the parent to get proper permissions
    if (thread.parentId) {
      try {
        const parent = await client.channels.fetch(thread.parentId);
        if (parent && "threads" in parent && parent.threads) {
          // Fetch through the parent's thread manager to get proper permissions
          const freshThread = await parent.threads.fetch(threadId);
          if (freshThread) {
            thread = freshThread;
            logger.trace(`Re-fetched thread ${threadId} via parent to get proper permissions`);
          }
        }
      } catch (parentErr) {
        logger.debug(`Failed to fetch thread through parent: ${parentErr}`);
        // Continue with the original thread fetch
      }
    }

    // If the thread shows we're not joined but we should be, try joining
    if (!thread.joined && thread.joinable) {
      try {
        await thread.join();
        // After joining, force refresh to get updated permissions
        thread = (await client.channels.fetch(threadId, { force: true })) as ThreadChannel;
        logger.debug(`Joined thread ${threadId} during fetch to ensure proper permissions`);
      } catch (joinErr) {
        logger.debug(`Failed to join thread ${threadId} during fetch: ${joinErr}`);
      }
    }

    return thread;
  } catch (err) {
    logger.debug(`Failed to fetch thread ${threadId}: ${err}`);
    return null;
  }
}

/**
 * Fetch thread information with enhanced member data
 * Uses multiple strategies to ensure we get the most accurate thread data
 */
export async function fetchThreadWithMembers(threadId: string): Promise<ThreadChannel | null> {
  try {
    // First try to fetch directly with force option to bypass cache
    const thread = await fetchThreadChannel(threadId);

    if (!thread) {
      return null;
    }

    // Ensure thread members are fetched for accurate permission checks
    if (thread.joined && !thread.members.me) {
      try {
        // Force refresh thread members
        await thread.members.fetch({ cache: true });
        logger.debug(`Fetched members for thread ${threadId}`);
      } catch (membersErr) {
        logger.debug(`Could not fetch members for thread ${threadId}: ${membersErr}`);
      }
    }

    // If we're joined according to thread.joined but there's no member entry,
    // try specifically fetching the bot's thread membership
    if (thread.joined && !thread.members.me && serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      try {
        // Check that client.user is not null before accessing id property
        if (client.user) {
          await thread.members.fetch(client.user.id);
          logger.debug(`Fetched bot member for thread ${threadId}`);
        } else {
          logger.debug(`Cannot fetch bot member: client.user is null for thread ${threadId}`);
        }
      } catch (botMemberErr) {
        logger.debug(`Could not fetch bot member for thread ${threadId}: ${botMemberErr}`);
      }
    }

    return thread;
  } catch (error) {
    logger.error(`Error in enhanced thread fetch for ${threadId}: ${error}`);
    return null;
  }
}

/**
 * Log the current thread state for debugging
 */
export function logThreadState(thread: ThreadChannel): void {
  logger.trace(
    `Thread ${thread.id} state: archived=${thread.archived}, locked=${thread.locked}, manageable=${thread.manageable}, ` +
      `joined=${thread.joined}, sendable=${thread.sendable}`
  );
}

/**
 * Check thread permissions more comprehensively
 */
export function checkEffectiveThreadPermissions(thread: ThreadChannel): boolean {
  try {
    // Check if the bot has the manage threads permission in guild
    const botMember = thread.guild?.members.me;
    if (!botMember) return false;

    // Check global permissions
    const hasManageThreadsGlobally = botMember.permissions.has(PermissionFlagsBits.ManageThreads);

    // Check parent channel permissions
    const parentPermissions = thread.parent?.permissionsFor(botMember);
    const hasManageThreadsInParent =
      parentPermissions?.has(PermissionFlagsBits.ManageThreads) || false;

    // Check thread-specific permissions
    const threadPermissions = thread.permissionsFor(botMember);
    const hasManageThreadsInThread =
      threadPermissions?.has(PermissionFlagsBits.ManageThreads) || false;

    const shouldBeAbleToManage =
      hasManageThreadsGlobally || hasManageThreadsInParent || hasManageThreadsInThread;

    if (shouldBeAbleToManage && !thread.manageable) {
      logger.debug(
        `Permission mismatch for ${thread.id}: ` +
          `Global=${hasManageThreadsGlobally}, ` +
          `Parent=${hasManageThreadsInParent}, ` +
          `Thread=${hasManageThreadsInThread}, ` +
          `yet manageable=${thread.manageable}`
      );
    }

    return shouldBeAbleToManage;
  } catch (err) {
    logger.debug(`Error checking effective permissions for thread ${thread.id}: ${err}`);
    return false;
  }
}

/**
 * Retrieves all threads from a thread-capable channel
 */
export async function getThreadsFromChannel(
  channel: ThreadCapableChannel
): Promise<ThreadChannel[]> {
  try {
    await rateLimitManager.waitForRateLimit(`channels/${channel.id}/threads`);

    const fetchActive = async (): Promise<FetchedThreads> => {
      try {
        return await channel.threads.fetchActive();
      } catch (error) {
        logger.warn(`Failed to fetch active threads from channel ${channel.id}: ${error}`);
        return { threads: new Collection(), members: new Collection() } as FetchedThreads;
      }
    };

    const fetchArchived = async (): Promise<FetchedThreadsMore> => {
      try {
        if (
          channel.guild.members.me &&
          channel
            .permissionsFor(channel.guild.members.me)
            .has(PermissionFlagsBits.ReadMessageHistory)
        ) {
          return await channel.threads.fetchArchived();
        }
      } catch (error) {
        logger.warn(`Failed to fetch archived threads from channel ${channel.id}: ${error}`);
      }
      return {
        threads: new Collection(),
        members: new Collection(),
        hasMore: false,
      } as FetchedThreadsMore;
    };

    const activeThreads = await handleApiError(null, fetchActive, {
      retries: 2,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.MEDIUM,
      context: `Thread Fetching - Active (${channel.id})`,
    });

    await rateLimitManager.waitForRateLimit(`channels/${channel.id}/threads/archived`);

    const archivedThreads = await handleApiError(null, fetchArchived, {
      retries: 2,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.MEDIUM,
      context: `Thread Fetching - Archived (${channel.id})`,
    });

    const mergedThreads = new Collection<string, ThreadChannel>();

    activeThreads.threads.forEach((thread, id) => {
      if (thread.parentId === channel.id) {
        mergedThreads.set(id, thread);
      }
    });

    archivedThreads.threads.forEach((thread, id) => {
      if (thread.parentId === channel.id) {
        mergedThreads.set(id, thread);
      }
    });

    return Array.from(mergedThreads.values());
  } catch (error) {
    logger.error(`Error fetching threads from channel ${channel.id}: ${error}`);
    return [];
  }
}

/**
 * Recursively gets all threads from a category
 */
export async function getThreadsFromCategory(category: CategoryChannel): Promise<ThreadChannel[]> {
  try {
    const threadCapableChannels = category.children.cache.filter(isThreadCapableChannel);

    if (threadCapableChannels.size === 0) {
      return [];
    }

    const threadPromises = threadCapableChannels.map(async (channel) => {
      try {
        return await getThreadsFromChannel(channel);
      } catch (error) {
        logger.warn(`Error fetching threads from channel ${channel.id}: ${error}`);
        return [];
      }
    });

    const threadArrays = await Promise.all(threadPromises);

    return threadArrays.flat();
  } catch (error) {
    logger.error(`Error getting threads from category ${category.id}: ${error}`);
    return [];
  }
}

/**
 * Gets all threads from any type of channel that might contain threads directly or indirectly
 */
export async function getAllThreads(channel: GuildBasedChannel): Promise<ThreadChannel[]> {
  if (channel instanceof CategoryChannel) {
    return await getThreadsFromCategory(channel);
  } else if (isThreadCapableChannel(channel)) {
    return await getThreadsFromChannel(channel);
  }

  return [];
}

/**
 * Helper function to check if a channel has appropriate permissions for thread management
 */
export function hasThreadPermissions(channel: GuildBasedChannel): boolean {
  if (!channel.guild.members.me) return false;

  const permissions = channel.permissionsFor(channel.guild.members.me);
  if (!permissions) return false;

  if (channel.type === ChannelType.GuildCategory) {
    return permissions.has(PermissionFlagsBits.ViewChannel);
  } else if (
    THREAD_CAPABLE_CHANNEL_TYPES.includes(
      channel.type as (typeof THREAD_CAPABLE_CHANNEL_TYPES)[number]
    )
  ) {
    return (
      permissions.has(PermissionFlagsBits.ViewChannel) &&
      permissions.has(PermissionFlagsBits.ManageThreads)
    );
  }

  return false;
}

/**
 * Determines if a regex matches a string, accounting for inverted expressions
 * @param str String to test against the regex pattern
 * @param reg Regular expression to test
 * @param inverted Whether to invert the result (true matches when pattern doesn't match)
 * @returns True if the string matches the pattern (or doesn't match, if inverted is true)
 */
export function regMatch(str: string, reg: RegExp, inverted: boolean): boolean {
  const matches = reg.test(str);
  return inverted ? !matches : matches;
}

/**
 * Determines if a thread should be watched based on configured filters
 * @param auto Channel data with filter rules
 * @param thread The thread to evaluate
 * @returns True if the thread should be watched, false otherwise
 */
export async function threadShouldBeWatched(
  channelData: ChannelData,
  thread: ThreadChannel
): Promise<boolean> {
  // If no channel data, don't watch
  if (!channelData) return false;

  const { regex, roles, tags } = channelData;
  let shouldWatch = true;

  try {
    // Check regex if provided
    if (regex && regex !== "") {
      try {
        // Instead of using new RegExp with a variable, use a pre-constructed RegExp object
        // This assumes regex is already a valid pattern string
        // The try/catch will still handle any invalid patterns
        shouldWatch = RegExp(regex, "i").test(thread.name);
      } catch (regexError) {
        logger.error(`Invalid regex pattern '${regex}' for thread ${thread.id}: ${regexError}`);
        // Default to not watching on invalid regex
        shouldWatch = false;
      }
    }

    // Skip further checks if regex already determined we shouldn't watch
    if (!shouldWatch) return false;

    // Check roles if provided
    if (shouldWatch && roles && roles.length > 0 && roles[0]) {
      const ownerMember = await thread.fetchOwner();
      if (!ownerMember) return false;

      // Service registry for client access
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) return false;
      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      if (!client.guilds) return false;

      const guild = client.guilds.cache.get(thread.guildId);
      if (!guild) return false;

      const member = await guild.members.fetch(ownerMember.id).catch(() => null);
      if (!member) return false;

      // Check if thread owner has any of the required roles
      shouldWatch = roles.some((role) => role && member.roles.cache.has(role));
    }

    // Check tags if provided
    if (shouldWatch && tags && tags.length > 0 && tags[0] && thread.appliedTags) {
      // Check if thread has any of the required tags
      shouldWatch = tags.some((tag) => tag && thread.appliedTags?.includes(tag));
    }

    return shouldWatch;
  } catch (error) {
    logger.error(`Error checking if thread should be watched: ${error}`);
    return false;
  }
}

/**
 * Get a Discord-formatted link to the channel
 * @param channel The channel to create a link for
 * @returns A markdown formatted link to the channel
 */
export function getDirectTag(c: ThreadCapableChannel | ThreadChannel | CategoryChannel): string {
  return `[#${c.name}](https://discord.com/channels/${c.guildId}/${c.id})`;
}

/**
 * Validate if a value is a valid ThreadChannel from an interaction
 * @param value The value to validate
 * @param errorHandler Optional handler for validation errors
 * @returns True if the value is a valid thread, false otherwise
 */
export function validateThread(
  value: unknown,
  errorHandler?: (errorCode: string, errorDetails: { id?: string; type?: number }) => void
): value is ThreadChannel {
  if (!value) {
    if (errorHandler) errorHandler("THREAD_MISSING", {});
    return false;
  }

  const threadLike = value as { id?: string; type?: number };

  if (!threadLike.id || !threadLike.type) {
    if (errorHandler)
      errorHandler("INVALID_THREAD_DATA", { id: threadLike.id, type: threadLike.type });
    return false;
  }

  if (!THREAD_CHANNEL_TYPES.includes(threadLike.type as (typeof THREAD_CHANNEL_TYPES)[number])) {
    if (errorHandler)
      errorHandler("INVALID_THREAD_TYPE", { id: threadLike.id, type: threadLike.type });
    return false;
  }

  if (!(value instanceof ThreadChannel)) {
    if (errorHandler) errorHandler("NOT_THREAD_INSTANCE", { id: threadLike.id });
    return false;
  }

  return true;
}

/**
 * Validate if a value is a valid thread-capable channel
 * @param value The value to validate
 * @param errorHandler Optional handler for validation errors
 * @returns True if the value is a valid thread-capable channel, false otherwise
 */
export function validateThreadCapableChannel(
  value: unknown,
  errorHandler?: (errorCode: string, errorDetails: { id?: string; type?: number }) => void
): value is ThreadCapableChannel {
  if (!value) {
    if (errorHandler) errorHandler("CHANNEL_MISSING", {});
    return false;
  }

  const channelLike = value as { id?: string; type?: number; guild?: unknown };

  if (!channelLike.id || !channelLike.type) {
    if (errorHandler)
      errorHandler("INVALID_CHANNEL_DATA", { id: channelLike.id, type: channelLike.type });
    return false;
  }

  if (
    !THREAD_CAPABLE_CHANNEL_TYPES.includes(
      channelLike.type as (typeof THREAD_CAPABLE_CHANNEL_TYPES)[number]
    )
  ) {
    if (errorHandler)
      errorHandler("INVALID_CHANNEL_TYPE", { id: channelLike.id, type: channelLike.type });
    return false;
  }

  if (!isThreadCapableChannel(value as GuildBasedChannel)) {
    if (errorHandler) errorHandler("NOT_THREAD_CAPABLE", { id: channelLike.id });
    return false;
  }

  return true;
}

/**
 * Create a standard error handler for thread validation in Discord interactions
 * @param interaction The interaction to respond to
 * @param embedBuilder Function to build embedded responses
 * @returns A function to handle validation errors
 */
export function createThreadValidationErrorHandler(
  interaction: CommandInteraction,
  embedBuilder: EmbedBuilderFunction
) {
  return (errorCode: string, errorDetails: { id?: string; type?: number }) => {
    let title = "Invalid Thread";
    let description = "The provided thread is invalid.";

    switch (errorCode) {
      case "THREAD_MISSING":
        title = "Thread Not Found";
        description =
          "No thread was provided. For forum posts, you need to pass the post with the thread option.";
        break;

      case "INVALID_THREAD_TYPE":
        title = "Not a Thread";
        description = errorDetails.id
          ? `<#${errorDetails.id}> is not a thread or forum post.`
          : "The provided channel is not a thread or forum post.";
        break;

      case "NOT_THREAD_INSTANCE":
        title = "Invalid Thread Type";
        description = "The specified channel exists but is not a valid thread.";
        break;

      case "CHANNEL_MISSING":
        title = "Channel Not Found";
        description = "No channel was provided.";
        break;

      case "INVALID_CHANNEL_TYPE":
        title = "Invalid Channel Type";
        description = errorDetails.id
          ? `<#${errorDetails.id}> is not a channel that can contain threads.`
          : "The provided channel cannot contain threads.";
        break;

      case "NOT_THREAD_CAPABLE":
        title = "Not Thread Capable";
        description = "The specified channel exists but cannot contain threads.";
        break;

      default:
        title = "Validation Error";
        description = `An unexpected error occurred (${errorCode}).`;
        break;
    }

    const embed = embedBuilder(title, "error" as StatusType, { description });

    if (interaction.deferred) {
      interaction.editReply({ embeds: [embed] }).catch((err) => {
        logger.error(`Failed to send validation error response: ${err}`);
      });
    } else {
      interaction
        .reply({
          embeds: [embed],
          flags: [MessageFlagsBitField.Flags.Ephemeral],
        })
        .catch((err) => {
          logger.error(`Failed to send validation error response: ${err}`);
        });
    }
  };
}

/**
 * Comprehensive thread status check that consolidates various status checks
 * into a single utility function to avoid redundancy
 */
export function getThreadStatus(thread: ThreadChannel): {
  isActive: boolean;
  needsMaintenance: boolean;
  permissionIssue: boolean;
  canManage: boolean;
  canSend: boolean;
  isJoined: boolean;
  errorCode?: string;
} {
  try {
    const isActive = !thread.archived;
    const joined = thread.joined;
    const manageable = thread.manageable;
    const sendable = thread.sendable;

    // Check if thread has permission inconsistencies
    const permissionIssue = hasPermissionInconsistency(thread);

    // Determine if thread needs maintenance
    const needsMaintenance =
      thread.archived ||
      !manageable ||
      permissionIssue ||
      (problemThreads.get(thread.id)?.failCount ?? 0) > 0;

    return {
      isActive,
      needsMaintenance,
      permissionIssue,
      canManage: manageable,
      canSend: sendable,
      isJoined: joined,
    };
  } catch (error) {
    // Handle errors in status checking with standard format
    logger.error(`Error checking thread status for ${thread.id}: ${error}`);

    // Report significant errors
    if (
      error instanceof Error &&
      (error.message.includes("Unknown Channel") || error.message.includes("Missing Access"))
    ) {
      reportError(error, `Thread Status Check (${thread.id})`);
    }

    // Return a failsafe status
    return {
      isActive: false,
      needsMaintenance: true,
      permissionIssue: true,
      canManage: false,
      canSend: false,
      isJoined: false,
      errorCode: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    };
  }
}

/**
 * Attempts to fix thread member consistency issues by refreshing thread state
 */
export async function repairThreadMemberConsistency(thread: ThreadChannel): Promise<boolean> {
  try {
    logger.debug(`Attempting to repair thread member consistency for ${thread.id}`);

    // 1. Force refresh thread data
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) return false;
    const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
    let refreshedThread = (await client.channels.fetch(thread.id, {
      force: true,
    })) as ThreadChannel;
    if (!refreshedThread) return false;

    // 2. Fetch thread members to update cache
    await refreshedThread.members.fetch({ cache: true }).catch((err) => {
      logger.debug(`Failed to fetch members for thread ${refreshedThread.id}: ${err}`);
    });

    // 3. If we're not joined but thread.joined says we are, try rejoining
    if (refreshedThread.joined && !refreshedThread.members.me && client.user) {
      // Leave and rejoin the thread
      try {
        logger.debug(`Thread ${thread.id} has inconsistent state, attempting leave/rejoin`);

        // Leave first if needed
        await client.rest.delete(`/channels/${thread.id}/thread-members/@me`).catch((err) => {
          logger.debug(`Failed to leave thread ${thread.id}: ${err}`);
        });

        // Wait a moment
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Rejoin
        await client.rest.put(`/channels/${thread.id}/thread-members/@me`);
        logger.debug(`Successfully reset thread ${thread.id} membership`);

        // Refresh the thread data again
        refreshedThread = (await client.channels.fetch(thread.id, {
          force: true,
        })) as ThreadChannel;

        return Boolean(refreshedThread?.members?.me);
      } catch (err) {
        logger.debug(`Failed to repair thread ${thread.id} consistency: ${err}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.debug(`Error repairing thread member consistency for ${thread.id}: ${error}`);
    return false;
  }
}

/**
 * Determine if a thread needs maintenance based on its due archive time
 */
export function threadNeedsMaintenance(thread: WatchedThread): boolean {
  if (!thread.watching) return false;

  // If no dueArchive timestamp, assume it needs maintenance
  if (!thread.dueArchive) return true;

  // Fix time unit mismatch - dueArchive is in seconds but Date.now() is in milliseconds
  const nowSeconds = Math.floor(Date.now() / 1000);

  // dueArchive is stored in seconds - no need for conversion
  return nowSeconds + 900 > thread.dueArchive; // 900 seconds = 15 minutes
}

/**
 * Get bot member data safely from a thread
 */
export function getBotMemberData(thread: ThreadChannel): {
  botMember: GuildMember | null;
  botThreadMember: ThreadMember | null;
  isJoined: boolean;
} {
  // Default return values
  let botMember: GuildMember | null = null;
  let botThreadMember: ThreadMember | null = null;

  try {
    // Get thread member (most reliable indicator of membership)
    botThreadMember = thread.members.me || null;
  } catch (err) {
    logger.debug(`Could not access thread.members.me for ${thread.id}: ${err}`);
  }

  try {
    // Get guild member
    botMember = thread.guild?.members.me || null;
  } catch (err) {
    logger.debug(`Could not access guild member for ${thread.id}: ${err}`);
  }

  return {
    botMember,
    botThreadMember,
    isJoined: thread.joined,
  };
}

/**
 * Check bot permissions at all levels (guild, channel, thread)
 */
export function checkBotPermissionLevels(
  thread: ThreadChannel,
  botMember: GuildMember | null
): {
  hasGlobalManageThreads: boolean;
  hasChannelManageThreads: boolean;
  hasThreadManagePerms: boolean;
} {
  // Default permission values
  let hasGlobalManageThreads = false;
  let hasChannelManageThreads = false;
  let hasThreadManagePerms = false;

  if (botMember) {
    // Check global permissions
    hasGlobalManageThreads = botMember.permissions.has(PermissionFlagsBits.ManageThreads);

    // Check parent channel permissions if available
    if (thread.parent) {
      const channelPerms = thread.parent.permissionsFor(botMember);
      hasChannelManageThreads = channelPerms?.has(PermissionFlagsBits.ManageThreads) || false;
    }

    // Check thread-specific permissions
    const threadPerms = thread.permissionsFor(botMember);
    hasThreadManagePerms = threadPerms?.has(PermissionFlagsBits.ManageThreads) || false;
  }

  return {
    hasGlobalManageThreads,
    hasChannelManageThreads,
    hasThreadManagePerms,
  };
}

/**
 * Determine if thread has permission inconsistencies based on member data
 */
export function detectPermissionInconsistencies(
  thread: ThreadChannel,
  memberData: ReturnType<typeof getBotMemberData>,
  permissionData: ReturnType<typeof checkBotPermissionLevels>
): boolean {
  const { botThreadMember, isJoined } = memberData;
  const { hasGlobalManageThreads, hasChannelManageThreads, hasThreadManagePerms } = permissionData;

  // Checks for inconsistency scenarios
  return (
    ((!thread.manageable || !thread.sendable) &&
      (hasGlobalManageThreads || hasChannelManageThreads || hasThreadManagePerms)) ||
    (isJoined && (!thread.manageable || !thread.sendable) && !thread.locked && !thread.archived) ||
    (isJoined && !botThreadMember && !thread.locked && !thread.archived)
  );
}

/**
 * Enhanced version of hasPermissionInconsistency that provides detailed diagnostics
 */
export function diagnoseThreadPermissions(thread: ThreadChannel): {
  hasInconsistency: boolean;
  details: Record<string, boolean | null | string>;
} {
  try {
    // Get bot member data
    const memberData = getBotMemberData(thread);
    const { botMember, botThreadMember, isJoined } = memberData;

    // Check permissions at different levels
    const permissionData = checkBotPermissionLevels(thread, botMember);
    const { hasGlobalManageThreads, hasChannelManageThreads, hasThreadManagePerms } =
      permissionData;

    // Detect inconsistencies
    const hasInconsistency = detectPermissionInconsistencies(thread, memberData, permissionData);

    // Return diagnostic results
    return {
      hasInconsistency,
      details: {
        isJoined,
        hasGlobalManageThreads,
        hasChannelManageThreads,
        hasThreadManagePerms,
        isManageable: thread.manageable,
        isSendable: thread.sendable,
        hasBotThreadMember: Boolean(botThreadMember),
        isLocked: thread.locked,
        isArchived: thread.archived,
      },
    };
  } catch (error) {
    logger.error(`Error diagnosing thread ${thread.id} permissions: ${error}`);

    return {
      hasInconsistency: true,
      details: {
        error: true,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
