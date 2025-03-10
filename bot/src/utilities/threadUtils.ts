import {
  CategoryChannel,
  ChannelType,
  Collection,
  CommandInteraction,
  FetchedThreads,
  FetchedThreadsMore,
  ForumChannel,
  GuildBasedChannel,
  MediaChannel,
  MessageFlagsBitField,
  NewsChannel,
  PermissionFlagsBits,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import { logger } from "../index";
import { statusType } from "../interfaces/command";
import { ChannelData } from "../interfaces/database";
import { EmbedBuilderFunction } from "./embedUtils";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import { rateLimitManager } from "./rateLimitManager";
import { strToRegex } from "./regex";

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
  channel: GuildBasedChannel | ThreadChannel<boolean>
): channel is ThreadChannel {
  return THREAD_CHANNEL_TYPES.includes(channel.type as (typeof THREAD_CHANNEL_TYPES)[number]);
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
  auto: ChannelData,
  thread: ThreadChannel
): Promise<boolean> {
  if (thread.locked) return false;

  const validRoles = new Collection<string, string>();
  (auto.roles?.filter((role) => role?.trim() !== "") || []).forEach((role) => {
    if (role) validRoles.set(role, role);
  });

  const validTags = new Collection<string, string>();
  (auto.tags?.filter((tag) => tag?.trim() !== "") || []).forEach((tag) => {
    if (tag) validTags.set(tag, tag);
  });

  if (auto.regex?.length > 0) {
    const reg = strToRegex(auto.regex);
    if (!regMatch(thread.name, reg.regex, reg.inverted)) {
      return false;
    }
  }

  if (validTags.size > 0) {
    const threadsAppliedTags = new Collection<string, string>();
    thread.appliedTags.forEach((tag) => threadsAppliedTags.set(tag, tag));

    const hasMatchingTag = validTags.some((_, tagId) => threadsAppliedTags.has(tagId));
    if (!hasMatchingTag) return false;
  }

  if (validRoles.size > 0 && thread.ownerId) {
    try {
      await rateLimitManager.waitForRateLimit(`guilds/${thread.guildId}/members`);

      const fetchOwner = async () => {
        return await thread.guild.members.fetch({
          user: thread.ownerId,
          force: false,
          cache: true,
        });
      };

      const owner = await handleApiError(null, fetchOwner, {
        retries: 1,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.LOW,
        context: `Thread Owner Fetch (${thread.id})`,
      });

      if (!owner) return false;

      const hasRequiredRole = validRoles.some((_, roleId) => owner.roles.cache.has(roleId));

      if (!hasRequiredRole) return false;
    } catch (error) {
      logger.error(`Failed to fetch thread owner for thread ${thread.id}: ${error}`);
      return false;
    }
  }

  return true;
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

    const embed = embedBuilder(title, statusType.error, { description });

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
