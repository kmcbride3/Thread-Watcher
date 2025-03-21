import { ThreadAutoArchiveDuration, ThreadChannel } from "discord.js";
import { logger } from "../index";
import { ThreadBumpResult } from "../interfaces/thread";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { handleApiError } from "./apiErrorHandler";
import { dueArchiveTimestamp } from "./threadUtils";

// IMPORTANT: Don't access any services at the module level!
// Import services only inside functions

// Export all functions through a lazy-loading pattern
export const threadActions = {
  /**
   * Add a thread to the database for watching
   */
  async addThread(id: string, dueArchive: number, server: string): Promise<boolean> {
    try {
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        logger.debug("Client not available when adding thread");
        return false;
      }
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        logger.debug("Database not available when adding thread");
        return false;
      }
      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);

      await db.insertThread(id, dueArchive, server);
      return true;
    } catch (err) {
      logger.error(`Failed to add thread ${id}: ${String(err)}`);
      return false;
    }
  },

  /**
   * Bump a thread's auto-archive time to maximum
   */
  async bumpAutoTime(thread: ThreadChannel): Promise<boolean> {
    try {
      const { rateLimitManager } = await import("./rateLimitManager");
      await rateLimitManager.waitForRateLimit(`thread/${thread.id}/bump`);

      if (!thread.manageable) {
        logger.debug(`Thread ${thread.id} is not manageable for auto-archive bumping`);
        return false;
      }

      // Use the longest auto-archive duration available
      await thread.setAutoArchiveDuration(ThreadAutoArchiveDuration.OneWeek);
      logger.debug(`Bumped thread ${thread.id} auto-archive duration to maximum`);
      return true;
    } catch (err) {
      logger.error(`Failed to bump thread ${thread.id} auto-time: ${String(err)}`);
      return false;
    }
  },

  /**
   * Remove a thread from the watchlist
   */
  async removeThread(threadID: string): Promise<boolean> {
    try {
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        logger.debug("Database not available when removing thread");
        return false;
      }

      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
      await db.deleteThread(threadID);
      return true;
    } catch (err) {
      logger.error(`Failed to remove thread ${threadID}: ${String(err)}`);
      return false;
    }
  },

  /**
   * Send a message to a thread as an activity signal
   */
  async sendThreadMessage(thread: ThreadChannel, message: string): Promise<ThreadBumpResult> {
    try {
      const { rateLimitManager } = await import("./rateLimitManager");

      if (!thread.sendable) {
        return {
          success: false,
          message: "Thread is not sendable",
        };
      }

      await rateLimitManager.waitForRateLimit(`channels/${thread.id}/messages`);

      // Send the message to the thread
      await thread.send(message);

      return {
        success: true,
        method: "message",
        message: "Thread maintained via message",
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to send message to thread ${thread.id}: ${errorMessage}`);

      return {
        success: false,
        message: `Failed to send message: ${errorMessage}`,
      };
    }
  },

  /**
   * Update the due archive timestamp in the database
   */
  async updateThreadTimestamp(thread: ThreadChannel): Promise<void> {
    try {
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        logger.debug("Database not available when updating thread timestamp");
        return;
      }

      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
      const newDueArchive = dueArchiveTimestamp(
        thread.autoArchiveDuration || ThreadAutoArchiveDuration.OneDay
      );

      await db.updateDueArchive(thread.id, newDueArchive);
    } catch (err) {
      logger.error(`Failed to update thread timestamp: ${String(err)}`);
    }
  },

  /**
   * Set the archive duration of a thread
   */
  async setArchive(
    thread: ThreadChannel,
    duration = ThreadAutoArchiveDuration.OneWeek
  ): Promise<boolean> {
    try {
      return await handleApiError(
        `Failed to set archive duration for thread ${thread.id}`,
        async () => {
          await thread.setAutoArchiveDuration(duration);
          return true;
        },
        2, // retries
        1000 // retry delay
      );
    } catch (err) {
      logger.error(`Failed to set thread archive duration: ${String(err)}`);
      return false;
    }
  },

  /**
   * Check if a thread exists
   */
  async threadExists(threadID: string): Promise<boolean> {
    try {
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        return false;
      }

      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      const channel = await client.channels.fetch(threadID).catch(() => null);
      return channel !== null;
    } catch {
      return false;
    }
  },

  /**
   * Send a brief activity message and optionally delete it after a delay
   */
  async sendActivityMessage(
    thread: ThreadChannel,
    message?: string,
    deleteAfter = 30000
  ): Promise<boolean> {
    try {
      const { rateLimitManager } = await import("./rateLimitManager");

      if (!thread.sendable) {
        logger.debug(`Thread ${thread.id} is not sendable for activity message`);
        return false;
      }

      await rateLimitManager.waitForRateLimit(`channels/${thread.id}/messages`);

      const content = message || "🧵 Keeping this thread active";
      const sentMessage = await thread.send({ content });

      if (deleteAfter > 0) {
        // Schedule message deletion after specified delay
        setTimeout(async () => {
          try {
            if (sentMessage.deletable) {
              await sentMessage.delete();
            }
          } catch (err) {
            logger.debug(`Failed to delete activity message in ${thread.id}: ${err}`);
          }
        }, deleteAfter);
      }

      return true;
    } catch (err) {
      logger.error(`Failed to send activity message to thread ${thread.id}: ${err}`);
      return false;
    }
  },

  /**
   * Join a thread, optionally using direct API call
   */
  async joinThread(thread: ThreadChannel, forceAPI = false): Promise<boolean> {
    try {
      if (!thread.joinable) {
        logger.debug(`Thread ${thread.id} is not joinable`);
        return false;
      }

      if (thread.joined) {
        logger.debug(`Already joined thread ${thread.id}`);
        return true;
      }

      const { rateLimitManager } = await import("./rateLimitManager");
      await rateLimitManager.waitForRateLimit(`channels/${thread.id}/thread-members`);

      if (forceAPI) {
        // Use direct API call for problematic threads
        if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
          return false;
        }

        const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
        await client.rest.put(`/channels/${thread.id}/thread-members/@me`);
        logger.debug(`Joined thread ${thread.id} using direct API call`);
      } else {
        // Use standard Discord.js method
        await thread.join();
        logger.debug(`Joined thread ${thread.id}`);
      }

      return true;
    } catch (err) {
      logger.error(`Failed to join thread ${thread.id}: ${err}`);
      return false;
    }
  },

  /**
   * Leave a thread if joined
   */
  async leaveThread(thread: ThreadChannel): Promise<boolean> {
    try {
      if (!thread.joined) {
        logger.debug(`Not joined to thread ${thread.id}, nothing to leave`);
        return true;
      }

      const { rateLimitManager } = await import("./rateLimitManager");
      await rateLimitManager.waitForRateLimit(`channels/${thread.id}/thread-members`);

      await thread.leave();
      logger.debug(`Left thread ${thread.id}`);
      return true;
    } catch (err) {
      logger.error(`Failed to leave thread ${thread.id}: ${err}`);
      return false;
    }
  },

  /**
   * Cycle thread membership by leaving and rejoining
   */
  async cycleThreadMembership(thread: ThreadChannel, waitBetween = 2000): Promise<boolean> {
    try {
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        return false;
      }

      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      logger.debug(`Cycling membership for thread ${thread.id}`);

      // Try to leave thread using direct API call
      try {
        await client.rest.delete(`/channels/${thread.id}/thread-members/@me`);
        logger.debug(`Left thread ${thread.id} during cycle`);
      } catch (leaveErr) {
        logger.debug(`Couldn't leave thread ${thread.id}, may not be joined: ${leaveErr}`);
      }

      // Wait between leave and join operations
      if (waitBetween > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitBetween));
      }

      // Try to join thread using direct API call
      try {
        await client.rest.put(`/channels/${thread.id}/thread-members/@me`);
        logger.debug(`Rejoined thread ${thread.id} during cycle`);
        return true;
      } catch (joinErr) {
        logger.error(`Failed to rejoin thread ${thread.id}: ${joinErr}`);
        return false;
      }
    } catch (err) {
      logger.error(`Failed to cycle thread membership for ${thread.id}: ${err}`);
      return false;
    }
  },

  /**
   * Toggle thread archived state to refresh it
   */
  async toggleThreadArchived(thread: ThreadChannel): Promise<boolean> {
    try {
      const { rateLimitManager } = await import("./rateLimitManager");
      const { ErrorSeverity, handleApiError } = await import("./errorSystem");

      if (!thread.manageable) {
        logger.debug(`Thread ${thread.id} is not manageable for toggling archive state`);
        return false;
      }

      await rateLimitManager.waitForRateLimit(`channels/${thread.id}/archived`);

      const wasArchived = thread.archived;

      // Toggle to opposite state
      await handleApiError(
        `Failed to set archive state for thread ${thread.id}`,
        async () => await thread.setArchived(!wasArchived),
        {
          retries: 1,
          retryDelay: 1000,
          reportAtSeverity: ErrorSeverity.MEDIUM,
          context: `Thread Archive Toggle (${thread.id})`,
        }
      );

      // If it wasn't archived, toggle back to unarchived
      if (!wasArchived) {
        await rateLimitManager.waitForRateLimit(`channels/${thread.id}/archived`);
        await handleApiError(
          `Failed to restore unarchived state for thread ${thread.id}`,
          async () => await thread.setArchived(false),
          {
            retries: 1,
            retryDelay: 1000,
            reportAtSeverity: ErrorSeverity.MEDIUM,
            context: `Thread Archive Restore (${thread.id})`,
          }
        );
      }

      logger.debug(`Successfully toggled archive state for thread ${thread.id}`);
      return true;
    } catch (err) {
      logger.error(`Failed to toggle archive state for thread ${thread.id}: ${err}`);
      return false;
    }
  },

  /**
   * Attempt to maintain a thread with permission issues using alternative approaches
   */
  async bumpStuckThread(thread: ThreadChannel): Promise<ThreadBumpResult> {
    try {
      const { handleProblemThread, diagnoseThreadPermissions } = await import("./threadUtils");

      logger.debug(
        `Using advanced techniques to maintain thread ${thread.id} with permission issues`
      );

      // Diagnose thread permissions for better targeted approaches
      const diagnosis = diagnoseThreadPermissions(thread);

      // Try specialized problem thread handler first
      if (diagnosis.hasInconsistency || !thread.manageable) {
        logger.debug(`Thread ${thread.id} identified as problematic, using specialized handler`);
        const result = await handleProblemThread(thread);

        if (result.success) {
          return result;
        }
      }

      // Try cycling membership as a last resort
      const result = await threadActions.cycleThreadMembership(thread);

      return {
        success: result,
        method: "cycle-membership",
        message: result
          ? "Thread maintained via membership cycling"
          : "Failed to maintain thread via membership cycling",
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to bump stuck thread ${thread.id}: ${errorMessage}`);

      return {
        success: false,
        message: `Advanced maintenance failed: ${errorMessage}`,
      };
    }
  },

  /**
   * Handle message fallback for threads we can't directly manipulate
   * This attempts to keep threads active by sending a message when permission issues prevent other methods
   */
  async handleMessageFallback(thread: ThreadChannel): Promise<ThreadBumpResult> {
    try {
      if (!thread.sendable) {
        return {
          success: false,
          message: "Thread is not sendable for message fallback",
        };
      }

      // Try to get custom bump message from settings
      let message = "🧵 Keeping this thread active";

      if (serviceRegistry.isAvailable(SERVICE_KEYS.USER_SETTINGS) && thread.guildId) {
        try {
          const userSettings = serviceRegistry.get(SERVICE_KEYS.USER_SETTINGS);
          const customMessage = await userSettings.getSetting(thread.guildId, "bumpMessage");
          if (customMessage && typeof customMessage === "string" && customMessage.trim() !== "") {
            message = customMessage.trim();
          }
        } catch {
          // Use default message if settings can't be retrieved
        }
      }

      // Send the message and return result
      const sentMessage = await thread.send(message);

      // Schedule deletion after 30 seconds if the message is deletable
      if (sentMessage.deletable) {
        setTimeout(async () => {
          try {
            await sentMessage.delete();
          } catch (err) {
            logger.debug(`Could not delete message in thread ${thread.id}: ${err}`);
          }
        }, 30000);
      }

      return {
        success: true,
        method: "message-fallback",
        message: "Thread maintained via fallback message",
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Message fallback failed for thread ${thread.id}: ${errorMessage}`);

      return {
        success: false,
        message: `Message fallback failed: ${errorMessage}`,
      };
    }
  },

  /**
   * Attempt to recover a thread with inconsistent permission state
   */
  async recoverInconsistentThread(thread: ThreadChannel): Promise<ThreadBumpResult> {
    try {
      const { repairThreadMemberConsistency } = await import("./threadUtils");

      logger.debug(`Attempting to recover inconsistent thread ${thread.id}`);

      // First try to repair member consistency
      const repaired = await repairThreadMemberConsistency(thread);

      if (repaired) {
        logger.debug(`Successfully repaired thread ${thread.id} consistency`);

        // If thread is now manageable, try unarchiving it
        if (thread.manageable && thread.archived) {
          await thread.setArchived(false);

          return {
            success: true,
            method: "consistency-repair",
            message: "Thread repaired and unarchived successfully",
          };
        }

        // If not archived but repaired, consider it a success
        if (!thread.archived) {
          return {
            success: true,
            method: "consistency-repair",
            message: "Thread membership consistency repaired",
          };
        }
      }

      // If repair failed, try cycling membership
      const cycleResult = await threadActions.cycleThreadMembership(thread);

      if (cycleResult) {
        return {
          success: true,
          method: "membership-cycle",
          message: "Thread recovered via membership cycling",
        };
      }

      return {
        success: false,
        message: "Failed to recover inconsistent thread state",
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover inconsistent thread ${thread.id}: ${errorMessage}`);

      return {
        success: false,
        message: `Recovery failed: ${errorMessage}`,
      };
    }
  },

  /**
   * Update the auto-archive duration of a thread
   */
  async updateArchiveDuration(
    thread: ThreadChannel,
    duration = ThreadAutoArchiveDuration.OneWeek
  ): Promise<boolean> {
    try {
      const { rateLimitManager } = await import("./rateLimitManager");

      if (!thread.manageable) {
        logger.debug(`Thread ${thread.id} is not manageable for archive duration update`);
        return false;
      }

      await rateLimitManager.waitForRateLimit(`channels/${thread.id}/archive-duration`);

      // Set to the maximum available duration
      await thread.setAutoArchiveDuration(duration);

      logger.debug(`Updated thread ${thread.id} auto-archive duration to ${duration} minutes`);
      return true;
    } catch (err) {
      logger.error(`Failed to update archive duration for thread ${thread.id}: ${err}`);
      return false;
    }
  },

  /**
   * Update thread health registry status
   */
  async updateThreadStatus(threadId: string, updates: Record<string, unknown>): Promise<void> {
    try {
      // Dynamically import to avoid circular dependencies
      const { updateThreadHealthStatus } = await import("./routines/threadMonitoring");

      // Pass updates to the thread health registry
      updateThreadHealthStatus(threadId, updates);

      logger.trace(`Updated status for thread ${threadId}`);
    } catch (err) {
      logger.debug(`Failed to update thread status for ${threadId}: ${err}`);
    }
  },

  /**
   * Refresh thread data by fetching from Discord and updating database
   * @param threadId The ID of the thread to refresh
   * @returns The refreshed thread or null if not found
   */
  async refreshThreadData(threadId: string): Promise<ThreadChannel | null> {
    try {
      const { fetchThreadWithMembers } = await import("./threadUtils");

      // Fetch latest thread data from Discord
      const thread = await fetchThreadWithMembers(threadId);
      if (!thread) {
        logger.debug(`Thread ${threadId} not found during refresh`);
        return null;
      }

      // Update thread in database with newest auto-archive duration
      if (serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE) && thread.autoArchiveDuration) {
        try {
          const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
          const dueArchive = Math.floor(Date.now() / 1000) + thread.autoArchiveDuration * 60;
          await db.updateDueArchive(threadId, dueArchive);
          logger.debug(`Updated thread ${threadId} due archive timestamp to ${dueArchive}`);
        } catch (dbErr) {
          logger.error(`Failed to update database for thread ${threadId}: ${dbErr}`);
        }
      }

      return thread;
    } catch (err) {
      logger.error(`Failed to refresh thread ${threadId}: ${err}`);
      return null;
    }
  },
};

// Re-export individual functions for backwards compatibility
export const addThread = threadActions.addThread;
export const bumpAutoTime = threadActions.bumpAutoTime;
export const removeThread = threadActions.removeThread;
export const sendThreadMessage = threadActions.sendThreadMessage;
export const updateThreadTimestamp = threadActions.updateThreadTimestamp;
export const setArchive = threadActions.setArchive;
export const threadExists = threadActions.threadExists;
export const sendActivityMessage = threadActions.sendActivityMessage;
export const joinThread = threadActions.joinThread;
export const leaveThread = threadActions.leaveThread;
export const cycleThreadMembership = threadActions.cycleThreadMembership;
export const toggleThreadArchived = threadActions.toggleThreadArchived;
export const bumpStuckThread = threadActions.bumpStuckThread;
export const handleMessageFallback = threadActions.handleMessageFallback;
export const recoverInconsistentThread = threadActions.recoverInconsistentThread;
export const updateArchiveDuration = threadActions.updateArchiveDuration;
export const updateThreadStatus = threadActions.updateThreadStatus;
export const refreshThreadData = threadActions.refreshThreadData;

// Add the rest of your functions here following the same pattern
export async function bumpUnknown(id: string): Promise<void> {
  try {
    const { fetchThreadChannel } = await import("./threadUtils");
    const thread = await fetchThreadChannel(id);
    if (thread) {
      await threadActions.bumpAutoTime(thread);
    }
  } catch (err) {
    logger.error(`Failed to bump unknown thread ${id}: ${String(err)}`);
  }
}

export async function clearGuild(server: string): Promise<void> {
  try {
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
      logger.debug("Database not available when clearing guild");
      return;
    }

    const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
    await db.deleteGuild(server);
  } catch (err) {
    logger.error(`Failed to clear guild ${server}: ${String(err)}`);
  }
}

// Add the remaining functions with the same pattern...
