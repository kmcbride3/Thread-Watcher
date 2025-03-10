import { ThreadChannel } from "discord.js";
import { db, logger } from "../index";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import {
  formatArchiveDuration,
  formatDiscordTimestamp,
  formatRelativeTimestamp,
} from "./formatUtils";
import { rateLimitManager } from "./rateLimitManager";
import { threadManager } from "./threadManager";
import { isThreadChannel, validateThread } from "./threadUtils";

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
 * Set the archive state of a thread
 */
export async function setArchive(thread: ThreadChannel, dueArchive?: number): Promise<void> {
  return await handleApiError(
    `Failed to set archive state for thread ${thread?.id || "unknown"}`,
    async () => {
      // Handle validation through error system instead of throwing
      if (!validateThread(thread)) {
        logger.error(
          `Invalid thread object provided to setArchive: ${(thread as ThreadChannel)?.id || "unknown"}`
        );
        return;
      }

      await rateLimitManager.waitForRateLimit(`channels/${thread.id}/archived`);

      if (thread.archived) {
        await thread.setArchived(false);

        if (dueArchive && thread.autoArchiveDuration !== dueArchive) {
          await rateLimitManager.waitForRateLimit(`channels/${thread.id}/auto-archive`);
          await thread.setAutoArchiveDuration(dueArchive);
          logger.debug(
            `Updated auto-archive duration for thread ${thread.id} to ${formatArchiveDuration(dueArchive)}`
          );
        }
      }
    },
    {
      retries: 2, // Retry twice
      retryDelay: 1000, // Delay 1 second between retries
      reportAtSeverity: ErrorSeverity.MEDIUM,
      context: `Thread Archive Management (${thread?.id || "unknown"})`,
    }
  );
}

/**
 * Update the due archive time for a thread
 */
export async function bumpAutoTime(thread: ThreadChannel): Promise<void> {
  await handleApiError(
    `Failed to bump auto time for thread ${thread?.id || "unknown"}`,
    async () => {
      // Handle validation through error system instead of throwing
      if (!isThreadChannel(thread)) {
        logger.error(
          `Invalid thread object provided to bumpAutoTime: ${(thread as ThreadChannel)?.id || "unknown"}`
        );
        return;
      }

      const watchedThread = threadManager.getWatchedThreads().get(thread.id);

      if (!watchedThread) {
        logger.warn(`Attempted to bump time for unwatched thread ${thread.id}`);
        return;
      }

      await rateLimitManager.waitForRateLimit(`db/threads/${thread.id}`);

      const newDueArchive = dueArchiveTimestamp(thread.autoArchiveDuration || 0);

      if (
        newDueArchive &&
        (!watchedThread.dueArchive || newDueArchive > watchedThread.dueArchive)
      ) {
        await db.updateDueArchive(thread.id, newDueArchive);
        const threadToUpdate = threadManager.getWatchedThreads().get(thread.id);
        if (threadToUpdate) {
          threadToUpdate.dueArchive = newDueArchive;
          logger.debug(
            `Updated due archive time for thread ${thread.id} to ${formatDiscordTimestamp(newDueArchive * 1000)}`
          );
        }
      }
    },
    {
      retries: 2,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.MEDIUM,
      context: `Thread Bump Management (${thread?.id || "unknown"})`,
    }
  );
}

/**
 * Add a thread to be watched
 */
export async function addThread(id: string, dueArchive: number, server: string): Promise<void> {
  await rateLimitManager.waitForRateLimit(`db/threads/${id}`);

  return handleApiError(
    `Failed to add thread ${id} to watch list`,
    async () => {
      await threadManager.addThreadToWatch(id, dueArchive, server);
      logger.info(
        `Thread ${id} added to watch list with archive time ${formatRelativeTimestamp(dueArchive * 1000)}`
      );
    },
    {
      retries: 2,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.HIGH,
      context: `Thread Watch Registration (${id})`,
    }
  );
}

/**
 * Remove a thread from being watched
 */
export async function removeThread(id: string): Promise<void> {
  await rateLimitManager.waitForRateLimit(`db/threads/${id}`);

  return handleApiError(
    `Failed to remove thread ${id} from watch list`,
    async () => {
      await threadManager.removeThreadFromWatch(id);
      logger.info(`Thread ${id} removed from watch list`);
    },
    {
      retries: 2,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.HIGH,
      context: `Thread Watch Removal (${id})`,
    }
  );
}

/**
 * For unknown threads, just set a far-future timestamp
 */
export async function bumpUnknown(id: string): Promise<void> {
  const timestamp = dueArchiveTimestamp(10_080);
  await db.updateDueArchive(id, timestamp);
  logger.debug(
    `Bumped unknown thread ${id} to future timestamp ${formatDiscordTimestamp(timestamp * 1000)}`
  );
}

/**
 * Clear all threads for a guild from memory and database
 */
export async function clearGuild(server: string): Promise<void> {
  try {
    const watchedThreads = threadManager.getWatchedThreads();
    const guildThreads = watchedThreads.filter((thread) => thread.server === server);

    const threadCount = guildThreads.size;
    logger.info(`Clearing ${threadCount} threads from guild ${server}`);

    for (const [threadId] of guildThreads) {
      await threadManager.removeThreadFromWatch(threadId, true);
    }

    await db.deleteGuild(server);
    logger.done(`Successfully cleared all ${threadCount} threads for guild ${server}`);
  } catch (err) {
    return handleApiError(
      `Failed to clear guild ${server}: ${err instanceof Error ? err.message : String(err)}`,
      () => clearGuild(server),
      {
        retries: 2,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.HIGH,
        context: `Guild Thread Cleanup (${server})`,
      }
    );
  }
}
