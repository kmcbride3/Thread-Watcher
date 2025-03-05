import { ThreadChannel } from "discord.js";
import { threadManager } from "./threadManager";
import { handleApiError } from "./apiErrorHandler";
import { db, logger } from "../index";
import { rateLimitManager } from "./rateLimitManager";

/**
 * Calculate due archive timestamp from minutes
 * @param dueArchive the amount of time a thread has to be inactive for discord to hide it, in minutes
 * @param fromDate from what timestamp to calculate when thread will be hidden
 * @returns {Number} the calculated timestamp where a thread will be hidden
 */
export function dueArchiveTimestamp(dueArchive: number, fromDate?: Date): number {
  // if an undefined value is passed we want to treat the thread as already stale
  // Previously we defaulted to simply the current date which meant that if the thread was already stale
  // and the bot did not manage to get the last message it would take a few days (or a week at most) until the bot
  // actually did its job
  let date = fromDate || new Date();
  if (fromDate !== undefined && !(fromDate instanceof Date)) {
    date = new Date(0);
  }

  return date.getTime() / 1000 + dueArchive * 60;
}

/**
 * Unarchive thread and set its auto-archive duration with rate limit and retry handling
 */
export function setArchive(thread: ThreadChannel, dueArchive = 10_080) {
  return new Promise((resolve, reject) => {
    const performSetArchive = async () => {
      if (thread.locked) return null;

      try {
        await thread.setArchived(false);

        let DArchive = thread.autoArchiveDuration;
        if (thread.manageable) {
          try {
            await thread.setAutoArchiveDuration(dueArchive);
            DArchive = dueArchive;
          } catch (durationErr) {
            logger.warn(
              `Failed to set auto-archive duration for thread ${thread.id}: ${durationErr}`
            );
          }
        }
        await db.updateDueArchive(thread.id, dueArchiveTimestamp(DArchive || 0));
        return null;
      } catch (err) {
        if (err && typeof err === "object" && "headers" in err) {
          rateLimitManager.updateFromHeaders(
            `/channels/${thread.id}`,
            err.headers as Record<string, string>
          );
        }
        throw err;
      }
    };

    // Use handleApiError for retries, with max 3 retries and 1000ms initial delay
    handleApiError(null, performSetArchive, 3, 1000).then(resolve).catch(reject);
  });
}

/**
 * Update thread's due archive time in memory and database
 */
export async function bumpAutoTime(thread: ThreadChannel): Promise<void> {
  try {
    const newTimeStamp = dueArchiveTimestamp(
      thread.autoArchiveDuration || 0,
      thread.lastMessage?.createdAt
    );

    // Use db directly without importing getDatabase
    await db.updateDueArchive(thread.id, newTimeStamp);
    const watchedThreads = threadManager.getWatchedThreads();

    if (watchedThreads.has(thread.id)) {
      const threadData = watchedThreads.get(thread.id);
      if (threadData) {
        threadData.dueArchive = newTimeStamp;
      }
    }
  } catch (error) {
    throw new Error(`Failed to bump auto time: ${error}`);
  }
}

/**
 * For unknown threads, just set a far-future timestamp
 */
export async function bumpUnknown(id: string): Promise<void> {
  // Use db directly
  await db.updateDueArchive(id, dueArchiveTimestamp(10_080));
}

/**
 * Add a thread to watch - delegates to threadManager
 */
export async function addThread(id: string, dueArchive: number, server: string): Promise<void> {
  try {
    await threadManager.addThreadToWatch(id, dueArchive, server);
  } catch (err) {
    return handleApiError(err, () => addThread(id, dueArchive, server), 3, 1000);
  }
}

/**
 * Remove thread from watch - delegates to threadManager
 */
export async function removeThread(id: string, force = false): Promise<void> {
  try {
    await threadManager.removeThreadFromWatch(id, force);
  } catch (err) {
    return handleApiError(err, () => removeThread(id, force), 2, 1000);
  }
}

/**
 * Clear all threads for a guild from memory and database
 */
export async function clearGuild(server: string): Promise<void> {
  try {
    // Get watched threads and filter by server
    const watchedThreads = threadManager.getWatchedThreads();
    const guildThreads = watchedThreads.filter((thread) => thread.server === server);

    // Remove each thread
    for (const [threadId] of guildThreads) {
      await threadManager.removeThreadFromWatch(threadId, true);
    }

    // Use db directly without importing
    await db.deleteGuild(server);
  } catch (err) {
    // Add proper typing for the error and provide max retries
    return handleApiError(err, () => clearGuild(server), 2, 1000);
  }
}
