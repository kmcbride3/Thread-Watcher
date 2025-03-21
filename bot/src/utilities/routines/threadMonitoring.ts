import { Collection, TextChannel, ThreadAutoArchiveDuration, ThreadChannel } from "discord.js";
import { LogLevel } from "log75";
import { logger } from "../../index";
import {
  ThreadBumpResult,
  ThreadMaintenanceResponse,
  ThreadMaintenanceResult,
  ThreadMaintenanceResultType,
  WatchedThread,
} from "../../interfaces/thread";
import { SERVICE_KEYS, serviceRegistry } from "../../services";
import { ErrorSeverity, handleApiError } from "../errorSystem";
import { rateLimitManager } from "../rateLimitManager";
import {
  bumpStuckThread,
  handleMessageFallback,
  recoverInconsistentThread,
  updateArchiveDuration,
} from "../threadActions";
import { threadManager } from "../threadManager";
import {
  checkEffectiveThreadPermissions,
  diagnoseThreadPermissions,
  fetchThreadWithMembers,
  hasPermissionInconsistency,
  isThreadChannel,
  logThreadState,
  MAX_BUMP_ATTEMPTS,
  problemThreads,
  threadNeedsMaintenance,
} from "../threadUtils";

// Change from Collection to Map for better semantic meaning - this isn't a Discord Collection
export const threadHealthRegistry = new Map<string, ThreadHealthData>();

/**
 * Interface containing only thread health-specific metadata
 * Separated from WatchedThread to reduce duplication
 */
export interface ThreadHealthData {
  lastMaintenance: number;
  needsMaintenance: boolean;
  bumpAttempts: number;
  isProblematic: boolean;
  parentId: string | null;
  lastActivity: number;
  shardId: number;
}

/**
 * Register a thread for health monitoring
 */
export function registerThreadForHealthMonitoring(thread: ThreadChannel): void {
  if (!thread || !thread.id) {
    logger.warn("Attempted to register invalid thread for health monitoring");
    return;
  }

  // Get shardId from service registry client - but only inside the function
  if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
    logger.debug("Client not available when registering thread for health monitoring");
    return;
  }

  const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
  const shardId = client.shard?.ids[0] ?? 0;

  // Check if the thread is already being watched
  const existingWatchedThread = threadManager.getWatchedThreads().get(thread.id);

  if (!existingWatchedThread?.watching) {
    // If thread isn't being watched, don't register it for health monitoring
    logger.debug(
      `Thread ${thread.id} isn't being watched, skipping health monitoring registration`
    );
    return;
  }

  // Only store health-specific data here
  const healthData: ThreadHealthData = {
    lastMaintenance: 0, // Never maintained yet
    needsMaintenance: false,
    bumpAttempts: 0,
    isProblematic: (problemThreads.get(thread.id)?.failCount ?? 0) >= MAX_BUMP_ATTEMPTS,
    parentId: thread.parentId,
    lastActivity: thread.lastMessage?.createdTimestamp || Date.now(),
    shardId,
  };

  threadHealthRegistry.set(thread.id, healthData);
  logger.debug(`Thread ${thread.id} registered for health monitoring`);
}

/**
 * Get combined thread data with both watching and health information
 * @param threadId The thread ID to get data for
 * @returns Combined thread data or null if not found
 */
export function getThreadWithHealthData(
  threadId: string
): (WatchedThread & Partial<ThreadHealthData>) | null {
  const watchedThread = threadManager.getWatchedThreads().get(threadId);
  if (!watchedThread) return null;

  const healthData = threadHealthRegistry.get(threadId);
  if (!healthData) {
    return watchedThread;
  }

  // Return combined data
  return {
    ...watchedThread,
    ...healthData,
  };
}

/**
 * Update thread health status
 * @param threadId ID of the thread to update
 * @param updates Partial object containing properties to update
 */
export function updateThreadHealthStatus(
  threadId: string,
  updates: Partial<ThreadHealthData>
): void {
  // Get existing entry or return if thread isn't registered
  const existingEntry = threadHealthRegistry.get(threadId);
  if (!existingEntry) {
    logger.debug(`Attempted to update unregistered thread ${threadId}`);
    return;
  }

  // Update entry with new properties
  threadHealthRegistry.set(threadId, { ...existingEntry, ...updates });

  // Log problematic threads so we can monitor them
  if (updates.isProblematic && !existingEntry.isProblematic) {
    logger.warn(`Thread ${threadId} is now marked as problematic in health registry`);
  }
}

/**
 * Mark a thread as needing maintenance
 */
export function markThreadForMaintenance(threadId: string): void {
  // Import dynamically to avoid circular dependencies
  import("../threadActions")
    .then(({ updateThreadStatus }) => {
      updateThreadStatus(threadId, { needsMaintenance: true });
    })
    .catch((err) => {
      logger.error(`Failed to import updateThreadStatus: ${err}`);
    });
}

/**
 * Check for threads that need maintenance and attempt to fix their state
 */
export async function monitorThreadHealth(): Promise<void> {
  const problematicThreads = Array.from(threadHealthRegistry.entries())
    .filter(([_, data]) => data.isProblematic)
    .map(([id, data]) => ({ id, ...data }));

  if (problematicThreads.length > 0) {
    logger.info(`Found ${problematicThreads.length} problematic threads for health monitoring`);
  }

  // Separate recently maintained threads
  const needsMaintenance = problematicThreads.filter((thread) => {
    const now = Date.now();
    return !thread.lastMaintenance || now - thread.lastMaintenance >= 3600000; // Over an hour ago
  });

  if (needsMaintenance.length > 0) {
    logger.info(`Processing ${needsMaintenance.length} threads that need maintenance`);
  }

  // Process threads that need maintenance
  for (const entry of needsMaintenance) {
    try {
      // Fetch the thread
      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      const thread = (await client.channels
        .fetch(entry.id)
        .catch(() => null)) as ThreadChannel | null;

      if (!thread) {
        // Thread no longer exists, remove from registry
        threadHealthRegistry.delete(entry.id);
        continue;
      }

      logger.info(`Running health check on problematic thread ${thread.id}`);

      // Attempt maintenance
      const result = await maintainThread(thread);

      // Update registry
      updateThreadHealthStatus(thread.id, {
        lastMaintenance: Date.now(),
        needsMaintenance: !result.success,
        bumpAttempts: entry.bumpAttempts + 1,
      });

      logger.debug(
        `Problematic thread ${thread.id} health check: ${result.success ? "successful" : "failed"}`
      );
    } catch (error) {
      logger.error(`Error monitoring problematic thread ${entry.id}: ${error}`);
    }
  }

  // Check for normal threads with permission issues
  try {
    // Get all watched threads
    const watchedThreads = threadManager.getWatchedThreads();

    for (const [threadId, watchData] of watchedThreads.entries()) {
      // Skip if not watching
      if (!watchData.watching) continue;

      try {
        // Only process a reasonable batch size per call
        // This prevents the function from running too long
        const MAX_THREADS_TO_CHECK = 50;
        if (problematicThreads.length > MAX_THREADS_TO_CHECK) break;
        // Fetch the thread
        const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
        const thread = (await client.channels
          .fetch(threadId)
          .catch(() => null)) as ThreadChannel | null;

        if (!thread) continue;

        // Check for permission inconsistencies
        if (hasPermissionInconsistency(thread)) {
          logger.info(`Found thread ${threadId} with permission inconsistency`);

          // Register if not already in registry
          if (!threadHealthRegistry.has(threadId)) {
            registerThreadForHealthMonitoring(thread);
          }

          // Run maintenance immediately
          const result = await bumpStuckThread(thread);

          const entry = threadHealthRegistry.get(threadId);
          if (entry) {
            updateThreadHealthStatus(threadId, {
              lastMaintenance: Date.now(),
              needsMaintenance: !result.success,
              bumpAttempts: (entry.bumpAttempts || 0) + 1,
              isProblematic: !result.success && entry.bumpAttempts >= 2,
            });
          }

          logger.info(
            `Thread ${threadId} inconsistency resolution: ${result.success ? "fixed" : "failed"}`
          );
        }
      } catch (err) {
        logger.error(`Error checking thread ${threadId} health: ${err}`);
      }
    }
  } catch (error) {
    logger.error(`Error in thread health monitoring: ${error}`);
  }
}

/**
 * Ensure threads remain visible by preventing archiving
 * Core thread-watcher functionality
 */
export async function ensureVisibleThreads(
  activeShardIds?: number[]
): Promise<ThreadMaintenanceResult> {
  // Check if we're shutting down before beginning maintenance
  if (process.exitCode !== undefined || global.isShuttingDown) {
    logger.debug("Skipping thread maintenance during shutdown");
    return {
      keptActive: 0,
      notFound: 0,
      noPermissions: 0,
      failedToActivate: 0,
      messageSent: 0,
      total: 0,
    };
  }

  // Get all threads that should be unarchived
  const watchedThreads = threadManager.getWatchedThreads();
  logger.trace(`Found ${watchedThreads.size} total threads in the watchedThreads collection`);

  // Early return if no threads are being watched at all
  if (watchedThreads.size === 0) {
    logger.info("No threads are currently being watched - skipping maintenance");
    return {
      keptActive: 0,
      notFound: 0,
      noPermissions: 0,
      failedToActivate: 0,
      messageSent: 0,
      total: 0,
    };
  }

  // First filter by shard ID
  const shardFilteredThreads = watchedThreads.filter((thread) => {
    // Skip unwatched threads
    if (!thread.watching) return false;

    // If activeShardIds is provided, filter by thread's shard directly
    if (activeShardIds?.length) {
      // Use stored shardId if available, otherwise fall back to guild lookup
      if (thread.shardId !== undefined) {
        return activeShardIds.includes(thread.shardId);
      } else {
        // Legacy fallback for threads that don't have shardId yet
        try {
          if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) return false;
          const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
          const guild = client.guilds.cache.get(thread.server);
          if (!guild || !activeShardIds.includes(guild.shardId)) {
            return false;
          }
        } catch {
          // If we can't determine the shard, include it by default
        }
      }
    }

    return true;
  });

  // Now filter for threads that actually need maintenance using the existing threadNeedsMaintenance function
  const threadsNeedingMaintenance = shardFilteredThreads.filter(threadNeedsMaintenance);

  logger.trace(
    `Filtered from ${shardFilteredThreads.size} threads to ${threadsNeedingMaintenance.size} threads that need maintenance`
  );

  // Early return if no threads need maintenance after filtering
  if (threadsNeedingMaintenance.size === 0) {
    logger.info("No threads need maintenance at this time - skipping maintenance process");
    return {
      keptActive: 0,
      notFound: 0,
      noPermissions: 0,
      failedToActivate: 0,
      messageSent: 0,
      total: 0,
    };
  }

  const result = await processThreadBatch(threadsNeedingMaintenance, activeShardIds);

  const successRate = result.total > 0 ? (result.keptActive / result.total) * 100 : 0;

  // Fix the possibly undefined logLevel check
  if ((logger.logLevel ?? LogLevel.Standard) >= LogLevel.Standard) {
    logger.done(
      `Thread maintenance completed. Kept Active: ${result.keptActive} of ${result.total} (${successRate.toFixed(1)}%)`
    );
  } else {
    logger.done(`Thread maintenance completed.
      Summary:
      - Kept Active: ${result.keptActive} (${successRate.toFixed(1)}%)
      - Bumped with Message: ${result.messageSent}
      - Not Found: ${result.notFound}
      - No Permissions: ${result.noPermissions}
      - Failed to Activate: ${result.failedToActivate}
      
      - Total: ${result.total}`);
  }

  return result;
}

/**
 * Process threads in batches to avoid hitting rate limits
 * @private
 */
async function processThreadBatch(
  threads: Collection<string, WatchedThread>,
  _activeShardIds?: number[]
): Promise<ThreadMaintenanceResult> {
  // Create a fresh result object for this specific run
  const result = {
    keptActive: 0,
    notFound: 0,
    noPermissions: 0,
    failedToActivate: 0,
    messageSent: 0,
    total: threads.size,
  };

  // Log a summary of what we're attempting to do
  logger.info(`Starting thread maintenance for ${threads.size} threads...`);

  // Process in smaller batches with rate limit awareness
  const batchSize = 8; // Smaller batch size to be safer with rate limits
  const threadEntries = Array.from(threads.entries());

  for (let i = 0; i < threadEntries.length; i += batchSize) {
    // Check for shutdown
    if (process.exitCode !== undefined || global.isShuttingDown) {
      logger.info("Thread maintenance interrupted due to shutdown");
      break;
    }

    const batch = threadEntries.slice(i, i + batchSize);
    logger.debug(
      `Processing thread batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(threadEntries.length / batchSize)}`
    );

    // Process threads in parallel but with a limit
    const batchResults = await Promise.all(
      batch.map(([threadId, _threadData]) => processThreadMaintenance(threadId))
    );

    // Process results and update counters
    for (const batchResult of batchResults) {
      updateResultCounters(result, batchResult);
    }

    // Add a delay between batches to avoid hitting global rate limits
    if (i + batchSize < threadEntries.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Provide a detailed summary of what happened
  logMaintenanceSummary(result);
  return result;
}

/**
 * Process an individual thread for maintenance
 * @private
 */
async function processThreadMaintenance(threadId: string): Promise<ThreadMaintenanceResponse> {
  return await handleApiError<ThreadMaintenanceResponse>(
    null,
    async () => {
      // Wait for channel fetch rate limit
      await rateLimitManager.waitForRateLimit(`channels/${threadId}`);
      logger.debug(`Maintaining thread ${threadId}...`);

      // IMPROVED: Use enhanced thread fetching with member data
      const thread = await fetchThreadWithMembers(threadId);

      // Check if it's a thread channel
      if (!thread || !isThreadChannel(thread)) {
        logger.debug(`Thread ${threadId} not found or not a thread channel`);
        return {
          threadId,
          result: "not-found",
        };
      }

      // Log thread state for debugging with enhanced member info
      logThreadState(thread);

      // Get server behavior settings
      const unarchiveOnly = await getServerBehaviorSetting(thread.guildId);

      // Handle thread with permission issues
      if (!thread.manageable || thread.locked) {
        return await handleThreadWithPermissionIssues(thread);
      }

      // Handle archived threads
      if (thread.archived) {
        return await unarchiveThread(thread, unarchiveOnly);
      }

      if (!thread.archived) {
        // Calculate new dueArchive time based on autoArchiveDuration
        const autoArchiveMinutes = thread.autoArchiveDuration || 1440; // Default 1 day
        const newDueArchive = Math.floor(Date.now() / 1000) + autoArchiveMinutes * 60;

        // Update in database
        const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
        await db.updateDueArchive(threadId, newDueArchive);

        // Also update in memory
        const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
        const watchedThread = threadManager.getWatchedThreads().get(threadId);
        if (watchedThread) {
          watchedThread.dueArchive = newDueArchive;
        }

        return { threadId, result: "kept-active" };
      }

      // Not archived, log and count as kept active
      logger.debug(`Thread ${threadId} is already active (not archived)`);
      return {
        threadId,
        result: "kept-active",
      };
    },
    {
      context: `Thread Batch Maintenance (${threadId})`,
      retries: 1,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.LOW,
    }
  ).catch((error) => {
    logger.error(`Unhandled error in thread maintenance for ${threadId}: ${error}`);
    return {
      threadId,
      result: "error",
      error,
    };
  });
}

// Cache for server behavior settings to prevent repeated database queries
const behaviorSettingsCache = new Collection<string, { value: boolean; timestamp: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get server behavior setting (unarchive-only mode)
 * Checks if the server has configured threads to only be unarchived without other actions
 * @private
 */
async function getServerBehaviorSetting(guildId?: string): Promise<boolean> {
  if (!guildId) return false;

  // Check cache first
  const cachedValue = behaviorSettingsCache.get(guildId);
  const now = Date.now();

  if (cachedValue && now - cachedValue.timestamp < CACHE_TTL) {
    return cachedValue.value;
  }

  try {
    // Use service registry to get UserSettings instance
    if (serviceRegistry.isAvailable(SERVICE_KEYS.USER_SETTINGS)) {
      const userSettings = serviceRegistry.get(SERVICE_KEYS.USER_SETTINGS);

      try {
        // Attempt to get the setting directly
        const behaviorSetting = await userSettings.getSetting(guildId, "BEHAVIOUR");
        const isUnarchiveOnly = behaviorSetting === "UNARCHIVE_ONLY";

        // Cache the result
        behaviorSettingsCache.set(guildId, { value: isUnarchiveOnly, timestamp: now });
        return isUnarchiveOnly;
      } catch (error) {
        // Error checking config or fetching setting, cache and return default
        logger.debug(`Error checking behavior setting for ${guildId}: ${error}`);
        behaviorSettingsCache.set(guildId, { value: false, timestamp: now });
        return false;
      }
    }
  } catch (error) {
    logger.debug(`Could not get behavior settings for guild ${guildId}: ${error}`);
    // Cache the default value
    behaviorSettingsCache.set(guildId, { value: false, timestamp: now });
  }

  return false;
}

/**
 * Handle threads with permission issues
 * @private
 */
async function handleThreadWithPermissionIssues(thread: ThreadChannel): Promise<{
  threadId: string;
  result: ThreadMaintenanceResultType;
}> {
  logger.debug(
    `Thread ${thread.id} permission issues: manageable=${thread.manageable}, locked=${thread.locked}, ` +
      `joined=${thread.joined}, joinable=${thread.joinable}`
  );

  // Check permissions more comprehensively - don't just rely on thread.manageable
  const canPotentiallyManage = await checkEffectiveThreadPermissions(thread);

  if (canPotentiallyManage && !thread.manageable) {
    logger.info(
      `Thread ${thread.id} appears to have permission inconsistency: has permissions but manageable=${thread.manageable}`
    );
  }

  // Special handling for inconsistent state (joined but can't manage/send)
  if (thread.joined && (!thread.manageable || !thread.sendable)) {
    logger.info(
      `Thread ${thread.id} has inconsistent permissions (joined=${thread.joined}, manageable=${thread.manageable}, sendable=${thread.sendable})`
    );

    // Attempt recovery via maintainThread
    const recoveryResult = await recoverInconsistentThread(thread);
    if (recoveryResult) {
      return {
        threadId: thread.id,
        result: recoveryResult.success ? "kept-active" : "failed-to-activate",
      };
    }
  }

  // Try message fallback for archived threads we can send to
  if (thread.archived && thread.sendable) {
    const shouldBumpWithMessage = await handleMessageFallback(thread);
    return {
      threadId: thread.id,
      result: shouldBumpWithMessage ? "message-sent" : "no-permissions",
    };
  }

  return {
    threadId: thread.id,
    result: "no-permissions",
  };
}

/**
 * Unarchive a thread and update its auto-archive duration if needed
 * @private
 */
async function unarchiveThread(
  thread: ThreadChannel,
  unarchiveOnly: boolean
): Promise<{
  threadId: string;
  result: ThreadMaintenanceResultType;
  error?: unknown;
}> {
  logger.debug(`Thread ${thread.id} is archived, attempting to unarchive`);
  try {
    await rateLimitManager.waitForRateLimit(`channels/${thread.id}/archived`);
    await thread.setArchived(false);
    logger.debug(`Successfully unarchived thread ${thread.id}`);

    // If not in unarchive-only mode, also update archive duration to maximum
    if (!unarchiveOnly && thread.manageable) {
      // If auto archive duration isn't already at maximum, extend it
      if (thread.autoArchiveDuration !== ThreadAutoArchiveDuration.OneWeek) {
        await updateArchiveDuration(thread);
      }
    }

    return {
      threadId: thread.id,
      result: "kept-active",
    };
  } catch (error) {
    // Check if error is a Discord API error with a code property
    return handleUnarchiveError(thread.id, error);
  }
}

/**
 * Handle errors during thread unarchiving
 * @private
 */
function handleUnarchiveError(
  threadId: string,
  error: unknown
): {
  threadId: string;
  result: ThreadMaintenanceResultType;
  error?: unknown;
} {
  logger.warn(`Failed to unarchive thread ${threadId}: ${error}`);
  // Check if this is a Discord permission error using proper type narrowing
  const discordError = error as { code?: number };
  if (
    discordError &&
    typeof discordError === "object" &&
    "code" in discordError &&
    (discordError.code === 50013 || discordError.code === 50001)
  ) {
    return {
      threadId,
      result: "no-permissions",
      error,
    };
  }

  return {
    threadId,
    result: "failed-to-activate",
    error,
  };
}

/**
 * Update result counters based on thread processing results
 * @private
 */
function updateResultCounters(
  result: ThreadMaintenanceResult,
  batchResult: ThreadMaintenanceResponse
): void {
  switch (batchResult.result) {
    case "kept-active":
      result.keptActive++;
      logger.debug(`Thread ${batchResult.threadId} was kept active`);
      break;

    case "not-found":
      result.notFound++;
      // Remove threads that can't be found from the database and memory
      handleNotFoundThread(batchResult.threadId);
      break;

    case "no-permissions":
      result.noPermissions++;
      logger.debug(`No permissions to maintain thread ${batchResult.threadId}`);
      break;

    case "failed-to-activate":
      result.failedToActivate++;
      logger.warn(`Failed to activate thread ${batchResult.threadId}`);
      break;

    case "message-sent":
      result.messageSent++;
      logger.debug(`Message sent to thread ${batchResult.threadId} instead of unarchiving`);
      break;

    case "error":
      // Log the error and count as failed to activate
      logger.error(`Error processing thread ${batchResult.threadId}: ${batchResult.error}`);
      result.failedToActivate++;
      break;

    default: {
      // Use type guard instead of type assertion
      const exhaustiveCheck: never = batchResult.result;
      logger.error(
        `Unhandled thread maintenance result "${exhaustiveCheck}" for thread ${batchResult.threadId}`
      );
      result.failedToActivate++;
      break;
    }
  }
}

/**
 * Handle thread that wasn't found (likely deleted)
 * @private
 */
async function handleNotFoundThread(threadId: string): Promise<void> {
  try {
    logger.info(`Thread ${threadId} not found - removing from watch list`);
    await threadManager.removeThreadFromWatch(threadId, true);
    logger.debug(`Successfully removed non-existent thread ${threadId}`);
  } catch (removeErr) {
    logger.error(`Failed to remove non-existent thread ${threadId} from database: ${removeErr}`);
  }
}

/**
 * Log maintenance summary after processing
 * @private
 */
function logMaintenanceSummary(result: ThreadMaintenanceResult): void {
  const totalProcessed =
    result.keptActive +
    result.notFound +
    result.noPermissions +
    result.failedToActivate +
    result.messageSent;

  logger.debug(`Thread maintenance summary:
    - Total threads:       ${result.total}
    - Actually processed:  ${totalProcessed}
    - Kept active:         ${result.keptActive}
    - Not found:           ${result.notFound} (removed from watch list)
    - No permissions:      ${result.noPermissions}
    - Failed to activate:  ${result.failedToActivate}
    - Message sent:        ${result.messageSent}`);
}

/**
 * Create a maintenance task to periodically ensure all threads are visible
 */
export function scheduleThreadMaintenanceTasks(activeShardIds?: number[]): NodeJS.Timeout {
  // Run the check every 30-60 minutes, randomized to avoid patterns
  const checkInterval = 30 * 60 * 1000 + Math.floor(Math.random() * 30 * 60 * 1000);

  // Store interval ID in a variable that can be returned
  const maintenanceInterval = setInterval(() => {
    // Check for shutdown before starting maintenance - bail immediately if shutting down
    if (global.isShuttingDown === true || process.exitCode !== undefined) {
      logger.debug("Thread maintenance task skipped due to shutdown");
      return;
    }

    ensureVisibleThreads(activeShardIds).catch((err) => {
      logger.error(`Thread maintenance task encountered an error: ${err}`);
    });
  }, checkInterval);

  // Make sure we clear the interval if we're already shutting down (edge case)
  if (global.isShuttingDown === true) {
    logger.debug("Clearing thread maintenance interval due to existing shutdown state");
    clearInterval(maintenanceInterval);
  }

  return maintenanceInterval;
}

/**
 * Get possibly archived threads for immediate maintenance
 * @param channelIds Array of channel IDs to check
 */
export async function getPossiblyArchivedThreads(channelIds: string[]): Promise<ThreadChannel[]> {
  const archivedThreads: ThreadChannel[] = [];

  for (const channelId of channelIds) {
    try {
      await rateLimitManager.waitForRateLimit(`channels/${channelId}/threads/archived`);

      if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        continue;
      }

      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      const channel = (await client.channels.fetch(channelId)) as TextChannel;
      if (!channel) continue;

      const archivedThreadsCollection = await channel.threads.fetchArchived();
      for (const [, thread] of archivedThreadsCollection.threads) {
        // Only add threads we're watching
        if (threadManager.isThreadWatched(thread.id)) {
          archivedThreads.push(thread);
        }
      }
    } catch (error) {
      logger.debug(`Could not fetch archived threads for channel ${channelId}: ${error}`);
    }
  }

  return archivedThreads;
}

/**
 * Perform maintenance on a thread to keep it active
 * This contains the higher-level maintenance strategy specific to monitoring
 */
export async function maintainThread(thread: ThreadChannel): Promise<ThreadBumpResult> {
  // Validate input
  if (!thread?.id) {
    logger.error("Invalid thread passed to maintainThread");
    return { success: false, message: "Invalid thread object" };
  }

  try {
    // Check if thread still exists and get fresh data
    const freshThread = await fetchThreadWithRetry(thread.id);
    if (!freshThread) {
      return { success: false, message: "Thread no longer exists" };
    }

    // Skip if thread is already active
    if (!freshThread.archived) {
      return { success: true, message: "Thread is already active", statusChange: false };
    }

    // Get server settings
    const unarchiveOnly = await getServerBehaviorSetting(freshThread.guildId);

    // Run diagnostics to determine the best strategy
    const diagnosis = diagnoseThreadPermissions(freshThread);

    logger.debug(
      `Thread ${freshThread.id} maintenance diagnosis: ${JSON.stringify(diagnosis.details)}`
    );

    // Use the diagnostic info to select appropriate strategy
    return await selectMaintenanceStrategy(freshThread, diagnosis, unarchiveOnly);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error maintaining thread ${thread.id}: ${errorMessage}`);
    return {
      success: false,
      message: `Maintenance failed: ${errorMessage}`,
    };
  }
}

/**
 * Select and execute the most appropriate maintenance strategy based on thread diagnostics
 * @private
 */
async function selectMaintenanceStrategy(
  thread: ThreadChannel,
  diagnosis: ReturnType<typeof diagnoseThreadPermissions>,
  unarchiveOnly: boolean
): Promise<ThreadBumpResult> {
  // Import needed actions
  const { bumpStuckThread, joinThread, sendThreadMessage } = await import("../threadActions");

  const { details } = diagnosis;

  // STRATEGY 1: If thread is manageable, use direct approach
  if (details.isManageable === true) {
    return await bumpStuckThread(thread);
  }

  // STRATEGY 2: If thread has permission inconsistency, try to recover first
  if (diagnosis.hasInconsistency) {
    logger.info(
      `Thread ${thread.id} has permission inconsistency, attempting specialized recovery`
    );

    // Try to recover using refreshed thread data
    const recoveryResult = await attemptThreadRecovery(thread);
    if (recoveryResult) {
      return recoveryResult;
    }
  }

  // STRATEGY 3: If thread is joinable but we're not joined, try joining first
  if (details.isJoined === false && thread.joinable) {
    logger.debug(`Thread ${thread.id} is joinable but not joined, trying to join first`);
    const joinSuccess = await joinThread(thread);

    if (joinSuccess) {
      // Refresh thread after joining to get updated permissions
      const refreshedThread = await fetchThreadWithRetry(thread.id);
      if (refreshedThread?.manageable) {
        return await bumpStuckThread(refreshedThread);
      }

      return { success: true, message: "Joined thread but couldn't unarchive" };
    }
  }

  // STRATEGY 4: Message fallback if allowed and possible
  if (!unarchiveOnly && details.isSendable === true) {
    logger.debug(`Using message fallback for thread ${thread.id}`);

    const bumpMessage = await getBumpMessage(thread.guildId);
    return await sendThreadMessage(thread, bumpMessage);
  }

  // No viable strategy found
  return {
    success: false,
    message: generateFailureMessage(thread, diagnosis),
  };
}

/**
 * Attempt specialized recovery methods for threads with permission inconsistencies
 * @private
 */
async function attemptThreadRecovery(thread: ThreadChannel): Promise<ThreadBumpResult | null> {
  try {
    // Import necessary utilities
    const { cycleThreadMembership, refreshThreadData } = await import("../threadActions");

    // Try membership cycling (leave and rejoin) to reset permission state
    const cycleSuccess = await cycleThreadMembership(thread);
    if (cycleSuccess) {
      const refreshedThread = await refreshThreadData(thread.id);
      if (refreshedThread?.manageable) {
        const { bumpStuckThread } = await import("../threadActions");
        const result = await bumpStuckThread(refreshedThread);
        result.method = "inconsistency-recovery";
        return result;
      }
    }

    // Try direct API method if cycling didn't help
    try {
      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      await client.rest.patch(`/channels/${thread.id}`, {
        body: { archived: false },
      });

      return {
        success: true,
        statusChange: true,
        method: "direct-api-recovery",
        message: "Thread unarchived via direct API call after inconsistency",
      };
    } catch (apiErr) {
      logger.debug(`Direct API recovery attempt failed for thread ${thread.id}: ${apiErr}`);
    }

    return null;
  } catch (error) {
    logger.debug(`Recovery attempt failed for thread ${thread.id}: ${error}`);
    return null;
  }
}

/**
 * Generate a helpful failure message based on thread diagnosis
 * @private
 */
function generateFailureMessage(
  thread: ThreadChannel,
  diagnosis: ReturnType<typeof diagnoseThreadPermissions>
): string {
  const details = diagnosis.details;
  const issues = [];

  if (!thread.joinable) issues.push("not joinable");
  if (!details.isManageable) issues.push("not manageable");
  if (!details.isSendable) issues.push("cannot send messages");
  if (thread.locked) issues.push("locked");
  if (diagnosis.hasInconsistency) issues.push("has permission inconsistency");

  if (details.isJoined && !details.isManageable) {
    issues.push("joined but missing manage permission");
  }

  const issueText = issues.length > 0 ? ` (${issues.join(", ")})` : "";
  return `Cannot maintain thread${issueText}`;
}

/**
 * Fetch thread with retry logic
 * @private
 */
async function fetchThreadWithRetry(threadId: string): Promise<ThreadChannel | null> {
  return await handleApiError(
    `Failed to fetch thread ${threadId}`,
    async () => {
      await rateLimitManager.waitForRateLimit(`channels/${threadId}`);

      if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        return null;
      }

      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      return await client.channels
        .fetch(threadId)
        .then((channel) => channel as ThreadChannel)
        .catch(() => null);
    },
    {
      retries: 2,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.LOW,
      context: "Thread Maintenance",
    }
  );
}

/**
 * Get appropriate bump message for a guild
 * @private
 */
async function getBumpMessage(guildId?: string): Promise<string> {
  // Default message
  const defaultMessage = "🧵 Keeping this thread active";

  if (!guildId || !serviceRegistry.isAvailable(SERVICE_KEYS.USER_SETTINGS)) {
    return defaultMessage;
  }

  try {
    const userSettings = serviceRegistry.get(SERVICE_KEYS.USER_SETTINGS);
    const customMessage = await userSettings.getSetting(guildId, "BUMP_MESSAGE");
    return customMessage || defaultMessage;
  } catch {
    return defaultMessage;
  }
}
