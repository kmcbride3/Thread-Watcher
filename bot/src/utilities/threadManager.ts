import {
  ChannelType,
  Collection,
  GuildBasedChannel,
  GuildTextThreadCreateOptions,
  REST,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";
import { db, logger } from "../index";
import { WatchedThread } from "../interfaces/thread";
import { handleApiError } from "./apiErrorHandler";
import { getRestClient } from "./discordRest";
import { rateLimitManager } from "./rateLimitManager";
import { isThreadCapableChannel, isThreadChannel } from "./threadUtils";

/**
 * Manages thread watching and unarchiving operations
 */
export class ThreadManager {
  private static instance: ThreadManager;
  private watchedThreads = new Collection<string, WatchedThread>();
  private threadCheckInterval: NodeJS.Timeout | null = null;
  private restClient: REST | null = null;
  private threadMonitoringInterval: NodeJS.Timeout | null = null;

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
    // Use the provided REST client or get a new one
    if (!this.restClient) {
      this.restClient = getRestClient();
    }
    return this.restClient;
  }

  /**
   * Start monitoring threads for auto-archiving
   */
  public startThreadMonitoring(): void {
    if (this.threadMonitoringInterval) return;
    logger.debug("[ThreadManager] Starting thread monitoring");
    this.threadMonitoringInterval = setInterval(
      () => {
        this.checkThreads();
      },
      typeof this.threadCheckInterval === "number" ? this.threadCheckInterval : 60000
    ); // Default to 60 seconds if null
  }

  public pauseThreadMonitoring(): void {
    if (!this.threadMonitoringInterval) return;
    logger.warn("[ThreadManager] Pausing thread monitoring");
    clearInterval(this.threadMonitoringInterval);
    this.threadMonitoringInterval = null;
  }

  /**
   * Stop thread monitoring
   */
  public stopThreadMonitoring(): void {
    if (this.threadCheckInterval) {
      clearInterval(this.threadCheckInterval);
      this.threadCheckInterval = null;
      logger.debug("Thread monitoring stopped");
    }
  }

  /**
   * Watch a thread to prevent auto-archiving
   * @param thread The thread to watch
   * @param server The server ID
   */
  public watchThread(thread: ThreadChannel, server: string): boolean {
    if (!isThreadChannel(thread)) {
      logger.warn(`Attempted to watch a non-thread channel: ${(thread as ThreadChannel).id}`);
      return false;
    }

    const threadData: WatchedThread = {
      id: thread.id,
      server,
      watching: true,
      dueArchive: ThreadManager.calculateArchiveTime(thread),
    };

    this.watchedThreads.set(thread.id, threadData);
    logger.trace(`Now watching thread ${thread.name} (${thread.id})`);
    return true;
  }

  /**
   * Stop watching a thread
   */
  public unwatchThread(threadId: string): boolean {
    const exists = this.watchedThreads.has(threadId);
    this.watchedThreads.delete(threadId);

    if (exists) {
      logger.trace(`Stopped watching thread ${threadId}`);
    }

    return exists;
  }

  /**
   * Get all watched threads
   */
  public getWatchedThreads(): Collection<string, WatchedThread> {
    return new Collection(this.watchedThreads);
  }

  /**
   * Create a new thread with optimized settings
   */
  public async createThread(
    channelId: string,
    options: GuildTextThreadCreateOptions<ChannelType.PublicThread> & {
      message?: string;
      watch?: boolean;
    }
  ): Promise<ThreadChannel | null> {
    try {
      // Import client dynamically to avoid circular dependency
      const { client } = await import("../bot");

      const targetChannel = await client.channels.fetch(channelId);
      if (
        !targetChannel ||
        !("guildId" in targetChannel) ||
        !isThreadCapableChannel(targetChannel as GuildBasedChannel)
      ) {
        logger.warn(`Cannot create thread in channel ${channelId}: not a thread-capable channel`);
        return null;
      }

      // Use the REST client directly for better control
      const rest = this.getRestClient();

      // Use REST API directly for thread creation
      const response = (await rest.post(`/channels/${channelId}/threads`, {
        body: {
          name: options.name,
          auto_archive_duration: options.autoArchiveDuration || ThreadAutoArchiveDuration.OneDay,
          type: ChannelType.PublicThread,
          message: options.message ? { content: options.message } : undefined,
        },
      })) as { id: string; headers: Record<string, string> };

      if (response?.id) {
        // Update rate limit info from response headers
        if (response.headers) {
          rateLimitManager.updateFromHeaders(`/channels/${channelId}/threads`, response.headers);
        }

        const thread = (await client.channels.fetch(response.id)) as ThreadChannel;

        // If requested to watch, add to watched threads
        if (options.watch && thread.guildId) {
          this.watchThread(thread, thread.guildId);
        }

        return thread;
      }

      return null;
    } catch (error) {
      logger.error(`Error creating thread in channel ${channelId}: ${error}`);
      return null;
    }
  }

  /**
   * Unarchive a thread if it's archived
   */
  public async unarchiveThread(threadId: string): Promise<boolean> {
    try {
      // Import client dynamically to avoid circular dependency
      const { client } = await import("../bot");

      await rateLimitManager.waitForRateLimit(`channels/${threadId}`);

      const fetchChannel = async () => await client.channels.fetch(threadId);
      const channel = await handleApiError(
        `Failed to fetch channel ${threadId}`,
        fetchChannel,
        2,
        1000
      );

      if (
        !channel ||
        !("guildId" in channel) ||
        !isThreadChannel(channel as GuildBasedChannel | ThreadChannel)
      ) {
        logger.warn(`Channel ${threadId} is not a thread - removing from watched threads`);
        this.unwatchThread(threadId);
        return false;
      }

      const threadChannel = channel as ThreadChannel;
      if (threadChannel.archived) {
        await rateLimitManager.waitForRateLimit(`channels/${threadId}/archived`);

        await handleApiError(
          `Failed to unarchive thread ${threadId}`,
          async () => await threadChannel.setArchived(false),
          3,
          1000
        );

        logger.debug(`Unarchived thread ${threadChannel.name} (${threadChannel.id})`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`Error unarchiving thread ${threadId}: ${error}`);
      return false;
    }
  }

  /**
   * Check all watched threads and unarchive if necessary
   * @private
   */
  private async checkThreads(): Promise<void> {
    const now = Date.now();

    const threadsToCheck = this.watchedThreads.filter(
      (thread) => thread.watching && thread.dueArchive && thread.dueArchive < now + 300000
    );

    logger.debug(`Checking ${threadsToCheck.size} threads due for archive soon`);

    // Process in small batches to avoid rate limits
    const batchSize = 5;
    let processedCount = 0;

    for (const [id, threadData] of threadsToCheck) {
      if (processedCount % batchSize === 0 && processedCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      try {
        const success = await this.unarchiveThread(id);

        if (success) {
          // Import client dynamically to avoid circular dependency
          const { client } = await import("../bot");

          // Update the due archive time with rate limit and error handling
          await rateLimitManager.waitForRateLimit(`channels/${id}`);

          const fetchThread = async () => (await client.channels.fetch(id)) as ThreadChannel;
          const thread = await handleApiError(null, fetchThread, 2, 1000);

          if (thread && isThreadChannel(thread)) {
            const updatedData = {
              ...threadData,
              dueArchive: ThreadManager.calculateArchiveTime(thread),
            };
            this.watchedThreads.set(id, updatedData);
          }
        }
      } catch (error) {
        logger.error(`Failed to process thread ${id}: ${error}`);
      }

      processedCount++;
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
      // Wait for rate limits before database operation
      await rateLimitManager.waitForRateLimit("db/threads");

      const threads = await handleApiError(
        "Failed to load threads from database",
        async () => await db.getAllWatchedThreads(),
        3,
        1000
      );

      // Clear existing collection
      this.watchedThreads.clear();

      // Add to local collection
      if (threads && threads.length > 0) {
        this.watchedThreads = new Collection(
          threads.map((thread) => [
            thread.id,
            {
              id: thread.id,
              server: thread.server,
              watching: thread.watching,
              dueArchive: thread.dueArchive,
            },
          ])
        );
      }

      logger.info(`Loaded ${this.watchedThreads.size} watched threads from database`);
    } catch (error) {
      logger.error(`Error loading threads from database: ${error}`);
    }
  }

  /**
   * Add a thread to watch in both memory and database
   */
  public async addThreadToWatch(id: string, dueArchive: number, server: string): Promise<boolean> {
    try {
      // Add to database directly
      await db.insertThread(id, dueArchive, server);

      // Add to local collection
      this.watchedThreads.set(id, {
        id,
        server,
        watching: true,
        dueArchive,
      });

      logger.trace(`Added thread ${id} to watch list`);
      return true;
    } catch (error) {
      logger.error(`Error adding thread ${id} to watch: ${error}`);
      return false;
    }
  }

  /**
   * Removes thread from both memory and database
   */
  public async removeThreadFromWatch(id: string, force = false): Promise<boolean> {
    try {
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
      logger.error(`Error removing thread ${id}: ${error}`);
      return false;
    }
  }
}

// Export singleton instance
export const threadManager = ThreadManager.getInstance();
