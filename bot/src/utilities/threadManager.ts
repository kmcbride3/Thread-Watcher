import {
  AllowedThreadTypeForTextChannel,
  ChannelType,
  Collection,
  GuildBasedChannel,
  GuildTextThreadCreateOptions,
  REST,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";
import { logger } from "../index";
import { WatchedThread } from "../interfaces/thread";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { handleApiError } from "./apiErrorHandler";
import {
  ensureVisibleThreads,
  monitorThreadHealth,
  registerThreadForHealthMonitoring,
  scheduleThreadMaintenanceTasks,
} from "./routines/threadMonitoring";
import {
  hasPermissionInconsistency,
  isThreadCapableChannel,
  isThreadChannel,
  threadNeedsMaintenance,
} from "./threadUtils";

/**
 * Manages thread watching and unarchiving operations
 */
export class ThreadManager {
  private static instance: ThreadManager;
  private watchedThreads = new Collection<string, WatchedThread>();
  private restClient: REST | null = null;
  private threadMonitoringInterval: NodeJS.Timeout | null = null;
  private isMonitoringPaused = false;
  private pendingMaintenance = false;
  private activeShards = new Set<number>();
  private inactiveShards = new Set<number>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Private constructor for singleton pattern
  private constructor() {
    // Empty constructor
  }

  public static getInstance(): ThreadManager {
    if (!ThreadManager.instance) {
      ThreadManager.instance = new ThreadManager();
    }
    return ThreadManager.instance;
  }

  /**
   * Set the REST client to use for API calls
   */
  public setRestClient(rest: REST): void {
    this.restClient = rest;
  }

  /**
   * Get the REST client, fetching a new one if not set
   * @private
   */
  private getRestClient(): REST {
    if (this.restClient) return this.restClient;

    try {
      if (serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
        return client.rest;
      }
    } catch {
      logger.warn(
        "Failed to get REST client from service registry, using fallback",
        "Thread Manager"
      );
    }

    // Fallback to creating a new REST client
    return new REST({ version: "10" });
  }

  /**
   * Start monitoring threads for auto-archiving
   */
  public startThreadMonitoring(shardId?: number): void {
    const effectiveShardId = shardId ?? 0;

    if (shardId !== undefined) {
      // Track this shard as active
      this.inactiveShards.delete(effectiveShardId);
      this.activeShards.add(effectiveShardId);
    } else {
      // Legacy mode: start monitoring globally
      logger.info("Starting thread monitoring across all shards", "Thread Manager");
    }

    // Start the interval if not already running
    if (!this.threadMonitoringInterval) {
      // First run immediate maintenance if needed
      if (this.pendingMaintenance) {
        this.pendingMaintenance = false;
        // Add a small delay to avoid potential race conditions
        setTimeout(() => {
          ensureVisibleThreads(Array.from(this.activeShards)).catch((err: Error) =>
            logger.error(
              `Failed to perform maintenance on startup: ${err}`,
              `SHARD ${effectiveShardId}`
            )
          );
        }, 500);
      }

      // Set up recurring monitoring
      this.threadMonitoringInterval = setInterval(
        () => {
          this.checkThreads();
        },
        60000 // Check once per minute for threads needing attention
      );

      // Schedule the periodic maintenance tasks
      scheduleThreadMaintenanceTasks(Array.from(this.activeShards));

      // Log that we've activated thread monitoring (maintain this single INFO message)
      logger.done(`Thread monitoring activated for Shard ${effectiveShardId}`, "Thread Manager");
    } else {
      // Only log at debug level if monitoring was already running
      logger.debug(
        `Thread monitoring already active for Shard ${effectiveShardId}`,
        "Thread Manager"
      );
    }

    this.isMonitoringPaused = false;
  }

  /**
   * Pause thread monitoring temporarily (during reconnections, etc.)
   */
  public pauseThreadMonitoring(shardId?: number): void {
    if (shardId !== undefined) {
      // Track this shard as inactive
      this.activeShards.delete(shardId);
      this.inactiveShards.add(shardId);
      logger.debug(`Pausing thread monitoring for shard ${shardId}`, "Thread Manager");

      return;
    }

    // Legacy mode: pause monitoring globally
    if (this.threadMonitoringInterval) {
      clearInterval(this.threadMonitoringInterval);
      this.threadMonitoringInterval = null;
      this.isMonitoringPaused = true;
      this.pendingMaintenance = true;
      logger.info("Pausing thread monitoring for all shards", "Thread Manager");
    }
  }

  /**
   * Stop thread monitoring completely
   */
  public stopThreadMonitoring(): void {
    if (this.threadMonitoringInterval) {
      logger.debug("Stopping thread monitoring", "Thread Manager");

      try {
        clearInterval(this.threadMonitoringInterval);
        this.threadMonitoringInterval = null;
        logger.debug("Thread monitoring stopped successfully", "Thread Manager");
      } catch (error) {
        logger.error(`Error stopping thread monitoring: ${error}`, "Thread Manager");
      }
    }

    this.isMonitoringPaused = false;

    // Also clear the pending maintenance flag to prevent scheduled runs
    this.pendingMaintenance = false;
  }

  /**
   * Watch a thread to prevent auto-archiving
   * @param thread The thread to watch
   * @param server The server ID
   */
  public watchThread(thread: ThreadChannel, server: string): boolean {
    if (!isThreadChannel(thread)) {
      logger.warn(
        `Attempted to watch a non-thread channel: ${(thread as ThreadChannel)?.id || "unknown"}`,
        "Thread Manager"
      );
      return false;
    }

    // Determine shard ID from the thread's guild - for memory only
    const shardId = thread.guild?.shardId ?? thread.client.shard?.ids[0] ?? 0;

    // Try to join the thread if we're not already a member
    if (!thread.joined) {
      // Always try to join, even if joinable is false (the flag can be incorrect)
      logger.debug(
        `Attempting to join thread ${thread.name} (${thread.id}) before watching`,
        "Thread Manager"
      );

      // Try the standard join first
      thread
        .join()
        .then(() => {
          logger.debug(
            `Joined thread ${thread.name} (${thread.id}) to gain proper access`,
            "Thread Manager"
          );
        })
        .catch(async (err) => {
          logger.warn(
            `Standard join failed for thread ${thread.name} (${thread.id}): ${err}`,
            "Thread Manager"
          );

          // Try API join as fallback
          try {
            const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
            await client.rest.put(`/channels/${thread.id}/thread-members/@me`, {});
            logger.debug(
              `Joined thread ${thread.name} (${thread.id}) via API method`,
              "Thread Manager"
            );
          } catch (apiErr) {
            logger.warn(
              `Failed to join thread ${thread.name} (${thread.id}) via any method: ${apiErr}`,
              "Thread Manager"
            );

            // Check for permission inconsistency and register for monitoring if needed
            if (hasPermissionInconsistency(thread)) {
              registerThreadForHealthMonitoring(thread);
              logger.info(
                `Registered thread ${thread.id} for health monitoring due to permission inconsistency`,
                "Thread Manager"
              );
            }
          }
        });
    }

    // Set thread in memory with shardId (only in memory, not database)
    this.watchedThreads.set(thread.id, {
      id: thread.id,
      server,
      watching: true,
      dueArchive: ThreadManager.calculateArchiveTime(thread),
      shardId, // Store the shardId in memory only
    });

    logger.trace(
      `Now watching thread ${thread.name} (${thread.id}) on shard ${shardId}`,
      "Thread Manager"
    );
    return true;
  }

  /**
   * Stop watching a thread
   */
  public unwatchThread(threadId: string): boolean {
    // Use Collection's has method for cleaner return value
    return this.watchedThreads.delete(threadId);
  }

  /**
   * Get all watched threads
   */
  public getWatchedThreads(): Collection<string, WatchedThread> {
    // Return a clone of the collection
    return this.watchedThreads.clone();
  }

  /**
   * Create a new thread with optimized settings
   */
  public async createThread(
    channelId: string,
    options: GuildTextThreadCreateOptions<AllowedThreadTypeForTextChannel> & {
      message?: string;
      watch?: boolean;
    }
  ): Promise<ThreadChannel | null> {
    return await handleApiError(
      `Failed to create thread in channel ${channelId}`,
      async () => {
        // Use service registry to get client
        const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);

        const targetChannel = await client.channels.fetch(channelId);
        if (
          !targetChannel ||
          !("guildId" in targetChannel) ||
          !isThreadCapableChannel(targetChannel as GuildBasedChannel)
        ) {
          logger.warn(
            `Cannot create thread in channel ${channelId}: not a thread-capable channel`,
            "Thread Manager"
          );
          return null;
        }

        // Ensure the channel has threads property (is a TextChannel, NewsChannel, etc.)
        if (!("threads" in targetChannel)) {
          logger.warn(`Channel ${channelId} does not support thread creation`, "Thread Manager");
          return null;
        }

        // UPDATED: Use Discord.js's thread creation API instead of direct REST calls
        let thread: ThreadChannel;

        try {
          // Use the channel's threads manager to create a thread
          const threadCreateOptions = {
            name: options.name,
            autoArchiveDuration: options.autoArchiveDuration || ThreadAutoArchiveDuration.OneDay,
            reason: "Created by Thread-Watcher",
          };

          // Check if it's a forum channel or another type that requires a message
          if (
            targetChannel.type === ChannelType.GuildForum ||
            targetChannel.type === ChannelType.GuildMedia
          ) {
            // Forums always require a message
            thread = await targetChannel.threads.create({
              ...threadCreateOptions,
              message: { content: options.message ?? "Thread created by Thread-Watcher" },
            });
            logger.debug(`Created forum thread ${thread.name} (${thread.id})`);
          } else if (options.message) {
            // Standard text channel with a message
            thread = await targetChannel.threads.create({
              ...threadCreateOptions,
              startMessage: options.message,
            });
            logger.debug(
              `Created thread ${thread.name} (${thread.id}) with starter message`,
              "Thread Manager"
            );
          } else {
            // Standard text channel without a message
            thread = await targetChannel.threads.create(threadCreateOptions);
            logger.debug(`Created thread ${thread.name} (${thread.id})`);
          }
        } catch (createError) {
          logger.warn(
            `Standard thread creation failed, falling back to REST API: ${createError}`,
            "Thread Manager"
          );

          // Only if standard method fails, fall back to direct REST API
          const rest = this.getRestClient();

          const response = (await rest.post(`/channels/${channelId}/threads`, {
            body: {
              name: options.name,
              auto_archive_duration:
                options.autoArchiveDuration || ThreadAutoArchiveDuration.OneDay,
              type: ChannelType.PublicThread,
              message: options.message ? { content: options.message } : undefined,
            },
          })) as { id: string };

          thread = (await client.channels.fetch(response.id)) as ThreadChannel;
        }

        // Ensure we're in the thread
        if (thread?.joinable && !thread.joined) {
          try {
            await thread.join();
            logger.debug(
              `Joined newly created thread ${thread.name} (${thread.id})`,
              "Thread Manager"
            );
          } catch (err) {
            logger.warn(
              `Failed to join newly created thread ${thread.id}: ${err}`,
              "Thread Manager"
            );
          }
        }

        // If requested to watch, add to watched threads
        if (options.watch && thread.guildId) {
          this.watchThread(thread, thread.guildId);
        }

        return thread;
      },
      2,
      1500
    );
  }

  /**
   * Check all watched threads and mark those needing attention
   * @private
   */
  private async checkThreads(): Promise<void> {
    // Skip if we're in the process of shutting down - check both flags
    if (process.exitCode !== undefined || global.isShuttingDown === true) {
      logger.debug("Skipping thread check during shutdown", "Thread Manager");
      return;
    }

    // Also check if monitoring was stopped or paused
    if (!this.threadMonitoringInterval || this.isMonitoringPaused) {
      logger.debug("Thread monitoring is paused or stopped, skipping check", "Thread Manager");
      return;
    }

    try {
      // Skip if there are no threads being watched at all
      if (this.watchedThreads.size === 0) {
        logger.trace("No threads are being watched, skipping maintenance check", "Thread Manager");
        return;
      }

      // Clean up non-existent threads periodically (every 6 hours)
      const SIX_HOURS = 6 * 60 * 60 * 1000;
      const shouldCleanup = Date.now() % SIX_HOURS < 60000; // Run during the first minute of every 6 hour period

      if (shouldCleanup) {
        logger.info("Starting scheduled cleanup of non-existent threads", "Thread Manager");
        await this.cleanupNonExistentThreads();
      }

      // Use the threadNeedsMaintenance function to determine which threads need attention
      // This is more accurate and considers thread auto-archive duration
      const threadsToCheck = this.watchedThreads.filter(
        (thread) => thread.watching && threadNeedsMaintenance(thread)
      );

      if (threadsToCheck.size === 0) {
        logger.trace("No threads need maintenance at this time", "Thread Manager");
        return;
      }

      // If we have threads that need attention, run the full maintenance routines
      logger.trace(`Checking ${threadsToCheck.size} threads for maintenance`, "Thread Manager");

      // Run the main thread maintenance routine
      await ensureVisibleThreads(Array.from(this.activeShards));

      // Also run health monitoring to check for problematic threads
      await monitorThreadHealth();
    } catch (error) {
      logger.error(`Error in checkThreads: ${error}`, "Thread Manager");
    }
  }

  /**
   * Clean up threads that no longer exist on Discord
   * @private
   */
  public async cleanupNonExistentThreads(): Promise<void> {
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
      logger.warn("Client not available, skipping thread cleanup");
      return;
    }

    const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
    const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);

    // Process in batches to avoid hitting rate limits
    const batchSize = 25;
    const threadIds = Array.from(this.watchedThreads.keys());
    const removedThreads = [];

    logger.trace(`Checking ${threadIds.length} threads for existence...`, "Thread Manager");

    // Process threads in batches
    for (let i = 0; i < threadIds.length; i += batchSize) {
      const batchThreadIds = threadIds.slice(i, i + batchSize);

      // Create a batch of promises that check if threads exist
      const batchPromises = batchThreadIds.map(async (threadId) => {
        try {
          await client.channels.fetch(threadId);
          // Thread exists, no action needed
          return null;
        } catch (error) {
          // Check if the error indicates the thread doesn't exist
          const errorString = String(error);
          if (
            errorString.includes("Unknown Channel") ||
            errorString.includes("404") ||
            errorString.includes("10003") // Discord API error code for unknown channel
          ) {
            // Thread doesn't exist, return its ID for cleanup
            const threadData = this.watchedThreads.get(threadId);
            const guildId = threadData?.server || "unknown";
            logger.debug(
              `Thread ${threadId} in guild ${guildId} no longer exists, will remove`,
              "Thread Manager"
            );
            return threadId;
          }

          // For other errors, log but don't remove the thread
          logger.warn(`Error checking thread ${threadId}: ${error}`, "Thread Manager");
          return null;
        }
      });

      // Wait for all batch checks to complete
      const results = await Promise.all(batchPromises);
      const threadsToRemove = results.filter(Boolean) as string[];

      // Remove non-existent threads from database and memory
      for (const threadId of threadsToRemove) {
        try {
          await db.deleteThread(threadId);
          this.unwatchThread(threadId);
          removedThreads.push(threadId);
        } catch (cleanupError) {
          logger.error(
            `Failed to remove non-existent thread ${threadId}: ${cleanupError}`,
            "Thread Manager"
          );
        }
      }

      // Add a small delay between batches to avoid rate limits
      if (i + batchSize < threadIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (removedThreads.length > 0) {
      logger.done(
        `Removed ${removedThreads.length} threads that no longer exist on Discord`,
        "Thread Manager"
      );
    } else {
      logger.debug("No non-existent threads found during cleanup", "Thread Manager");
    }
  }

  /**
   * Calculate when a thread would be auto-archived
   * @private
   */
  private static calculateArchiveTime(thread: ThreadChannel): number | undefined {
    if (!thread.autoArchiveDuration) return undefined;

    // Convert minutes to milliseconds and add to last activity timestamp
    const archiveDuration = thread.autoArchiveDuration * 60 * 1000;
    return (thread.lastMessage?.createdTimestamp || Date.now()) + archiveDuration;
  }

  /**
   * Synchronize our internal collection with the database
   */
  public async loadThreadsFromDatabase(): Promise<void> {
    try {
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        logger.warn("Database service not available yet for thread loading", "Thread Manager");
        return;
      }

      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
      const threads = await db.getAllWatchedThreads();
      logger.trace(`Loaded ${threads.length} threads from database`, "Thread Manager");

      // Clear existing watchedThreads to avoid stale data
      this.watchedThreads.clear();

      for (const thread of threads) {
        if (thread.watching) {
          // Calculate shardId at runtime for memory storage only
          const calculatedShardId = ThreadManager.determineShardIdFromServer(thread.server);

          this.watchedThreads.set(thread.id, {
            id: thread.id,
            server: thread.server,
            watching: Boolean(thread.watching),
            dueArchive: thread.dueArchive,
            shardId: calculatedShardId, // Calculate the shardId at runtime
          });
        }
      }

      logger.debug(`Thread Manager now watching ${this.watchedThreads.size} threads from database`);

      // Set up regular cleanup to ensure memory state matches database
      this.setupThreadCleanup();
    } catch (error) {
      logger.error(`Failed to load threads from database: ${error}`, "Thread Manager");
      throw error;
    }
  }

  /**
   * Add a thread to watch in both memory and database
   */
  public async addThreadToWatch(id: string, dueArchive: number, server: string): Promise<boolean> {
    try {
      // Check for race condition where thread might have been added already
      if (this.isThreadWatched(id)) {
        logger.debug(`Thread ${id} already being watched, updating archive time`, "Thread Manager");
        const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
        await db.updateDueArchive(id, dueArchive);
        return true;
      }

      // Calculate shardId for memory only
      const calculatedShardId = ThreadManager.determineShardIdFromServer(server);

      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
      // Add to database without shardId
      await db.insertThread(id, dueArchive, server);

      // Add to local collection with shardId
      this.watchedThreads.set(id, {
        id,
        server,
        watching: true,
        dueArchive,
        shardId: calculatedShardId, // Only in memory
      });

      logger.trace(
        `Added thread ${id} to watch list on shard ${calculatedShardId}`,
        "Thread Manager"
      );
      return true;
    } catch (error) {
      logger.error(`Error adding thread ${id} to watch: ${error}`, "Thread Manager");
      return false;
    }
  }

  /**
   * Removes thread from both memory and database
   */
  public async removeThreadFromWatch(id: string, force = false): Promise<boolean> {
    try {
      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
      // Remove from database directly
      if (force) {
        await db.deleteThread(id);
      } else {
        await db.unwatchThread(id);
      }

      // Remove from local collection
      const existed = this.unwatchThread(id);

      return existed;
    } catch (error) {
      logger.error(`Error removing thread ${id}: ${error}`, "Thread Manager");
      return false;
    }
  }

  /**
   * Safely check if a thread is being watched
   * @param threadId The thread ID to check
   * @returns True if the thread is being watched, false otherwise
   */
  public isThreadWatched(threadId: string): boolean {
    return (
      this.watchedThreads.has(threadId) && Boolean(this.watchedThreads.get(threadId)?.watching)
    );
  }

  /**
   * Try to determine shardId from server ID without fetching
   * @private
   */
  private static determineShardIdFromServer(serverId: string): number {
    try {
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        return 0; // Default to shard 0 if client not available
      }

      // Use service registry to get client
      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);

      if (client.shard) {
        // If client has a shard, use the first shard ID
        return client.shard.ids[0];
      } else if (client.options.shardCount && client.options.shardCount > 1) {
        // Calculate shard ID using the guild ID
        const guildIdBigInt = BigInt(serverId);
        const numShards = BigInt(client.options.shardCount);
        return Number((guildIdBigInt >> 22n) % numShards);
      }
    } catch (error) {
      logger.debug(`Error determining shard ID: ${error}`);
    }

    // Default to shard 0 if we can't determine the shard
    return 0;
  }

  /**
   * Update the thread cache from database to ensure consistency
   */
  public async synchronizeWithDatabase(): Promise<void> {
    try {
      logger.debug("Synchronizing thread cache with database...");
      await this.loadThreadsFromDatabase();
      logger.done("Thread cache synchronized with database");

      // Mark that we need maintenance after a synchronization
      this.pendingMaintenance = true;

      // Check for problematic threads and register them for monitoring
      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);

      // Get a sample of threads to check (limit to avoid overloading)
      const MAX_THREADS_TO_CHECK = 100;
      const watchedThreads = Array.from(this.watchedThreads.entries()).slice(
        0,
        MAX_THREADS_TO_CHECK
      );

      // Register threads with the monitoring system
      for (const [threadId, threadData] of watchedThreads) {
        try {
          if (threadData.watching) {
            const thread = (await client.channels
              .fetch(threadId)
              .catch(() => null)) as ThreadChannel | null;

            if (thread && hasPermissionInconsistency(thread)) {
              registerThreadForHealthMonitoring(thread);
            }
          }
        } catch (error) {
          logger.debug(
            `Error checking thread ${threadId} during synchronization: ${error}`,
            "Thread Manager"
          );
        }
      }
    } catch (error) {
      logger.error(`Failed to synchronize thread cache: ${error}`, "Thread Manager");
      this.pendingMaintenance = true;
    }
  }

  /**
   * Set up periodic cleanup to ensure memory state matches database state
   * This helps fix any potential inconsistencies between memory and database
   */
  private setupThreadCleanup(): void {
    // Clean up existing interval if it exists
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Run cleanup every 30 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.verifyThreadConsistency().catch((err) =>
          logger.error(`Error in thread consistency check: ${err}`)
        );
      },
      30 * 60 * 1000
    ); // 30 minutes
  }

  /**
   * Verify that threads in memory match database state
   */
  private async verifyThreadConsistency(): Promise<void> {
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
      return;
    }

    try {
      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
      const dbThreads = await db.getAllWatchedThreads();

      // Create maps for easier comparison
      const dbThreadMap = new Map<string, WatchedThread>();
      for (const thread of dbThreads) {
        if (thread.watching) {
          dbThreadMap.set(thread.id, thread);
        }
      }

      // Find threads in memory that aren't in DB (or aren't watching in DB)
      const threadsToRemove: string[] = [];
      for (const [threadId, _threadData] of this.watchedThreads.entries()) {
        const dbThread = dbThreadMap.get(threadId);
        if (!dbThread || !dbThread.watching) {
          threadsToRemove.push(threadId);
        }
      }

      // Remove inconsistent threads from memory
      for (const threadId of threadsToRemove) {
        this.watchedThreads.delete(threadId);
        logger.debug(`Removed inconsistent thread ${threadId} from memory`);
      }

      // Find threads in DB that aren't in memory
      for (const [threadId, threadData] of dbThreadMap.entries()) {
        if (threadData.watching && !this.watchedThreads.has(threadId)) {
          this.watchedThreads.set(threadId, { ...threadData, watching: true });
          logger.debug(`Added missing thread ${threadId} to memory`);
        }
      }

      logger.debug("Thread consistency check completed.");

      // Periodically clean up non-existent threads
      // Only run cleanup occasionally during consistency verification (roughly once a day)
      const shouldCleanup = Math.random() < 0.05; // 5% chance each verification

      if (shouldCleanup) {
        logger.info("Performing periodic cleanup of non-existent threads", "Thread Manager");
        await this.cleanupNonExistentThreads();
      }
    } catch (error) {
      logger.error(`Error verifying thread consistency: ${error}`);
    }
  }

  /**
   * Get threads for a specific server with accurate filtering
   */
  public getThreadsForServer(serverId: string): Collection<string, WatchedThread> {
    // Filter threads by server ID and ensure they are being watched
    const threads = this.watchedThreads.filter(
      (thread) => thread.server === serverId && thread.watching
    );
    logger.debug(
      `Found ${threads.size} threads for server ${serverId} of ${this.watchedThreads.size} total threads`
    );
    return threads;
  }
}

// Export singleton instance
export const threadManager = ThreadManager.getInstance();
