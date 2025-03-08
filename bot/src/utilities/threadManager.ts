import {
  ThreadChannel,
  GuildTextThreadCreateOptions,
  Collection,
  ChannelType,
  ThreadAutoArchiveDuration,
  REST,
} from "discord.js";
import { WatchedThread } from "../interfaces/thread";
import { getRestClient } from "./discordRest";
import { rateLimitManager } from "./rateLimitManager";
import { logger, db } from "../index";

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
   */
  public watchThread(thread: ThreadChannel, server: string): void {
    const threadData: WatchedThread = {
      id: thread.id,
      server: server,
      watching: true,
      dueArchive: this.calculateArchiveTime(thread),
    };

    this.watchedThreads.set(thread.id, threadData);
    logger.trace(`Now watching thread ${thread.name} (${thread.id})`);
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

      if (response && response.id) {
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

      const thread = (await client.channels.fetch(threadId)) as ThreadChannel;

      if (!thread) {
        logger.warn(`Thread ${threadId} not found - removing from watched threads`);
        this.unwatchThread(threadId);
        return false;
      }

      if (thread.archived) {
        await thread.setArchived(false);
        logger.debug(`Unarchived thread ${thread.name} (${thread.id})`);
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
    const threadsToCheck = new Array(...this.watchedThreads.entries());

    // Process in small batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < threadsToCheck.length; i += batchSize) {
      const batch = threadsToCheck.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async ([id, threadData]) => {
          if (!threadData.watching) return null;

          // If thread is due for archiving soon (next 5 minutes), unarchive it
          if (threadData.dueArchive && threadData.dueArchive < now + 300000) {
            try {
              const success = await this.unarchiveThread(id);

              if (success) {
                // Import client dynamically to avoid circular dependency
                const { client } = await import("../bot");
                // Update the due archive time
                const thread = (await client.channels.fetch(id)) as ThreadChannel;
                if (thread) {
                  const updatedData = {
                    ...threadData,
                    dueArchive: this.calculateArchiveTime(thread),
                  };
                  this.watchedThreads.set(id, updatedData);
                }
              }
            } catch (error) {
              logger.error(`Failed to process thread ${id}: ${error}`);
            }
          }
        })
      );

      // Add a small delay between batches
      if (i + batchSize < threadsToCheck.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Calculate when a thread would be auto-archived
   * @private
   */
  private calculateArchiveTime(thread: ThreadChannel): number | undefined {
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
      // Get all threads from database directly
      const threads = await db.getAllWatchedThreads();

      // Clear existing collection
      this.watchedThreads.clear();

      // Add to local collection
      for (const thread of threads) {
        this.watchedThreads.set(thread.id, {
          id: thread.id,
          server: thread.server,
          watching: thread.watching,
          dueArchive: thread.dueArchive,
        });
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
