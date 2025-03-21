import { Events, ThreadChannel } from "discord.js";
import { logger } from "../index";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { ErrorSeverity, handleApiError } from "../utilities/errorSystem";
import { rateLimitManager } from "../utilities/rateLimitManager";
import { threadManager } from "../utilities/threadManager";
import {
  dueArchiveTimestamp,
  isThreadChannel,
  threadShouldBeWatched,
} from "../utilities/threadUtils";

export default {
  name: Events.ThreadCreate,
  once: false,
  async execute(thread: ThreadChannel) {
    if (!isThreadChannel(thread)) {
      logger.warn(
        `Thread create event received non-thread channel: ${(thread as ThreadChannel).id}`
      );
      return null;
    }

    try {
      await rateLimitManager.waitForRateLimit(`guilds/${thread.guildId}/threads`);

      const getChannels = async () => {
        // Get the database with safer access pattern
        if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
          logger.warn(`Database not available for thread creation handling: ${thread.id}`);
          return [];
        }

        const db = serviceRegistry.get(SERVICE_KEYS.DATABASE, {
          errorContext: `ThreadCreate:getDatabase(${thread.guildId})`,
        });

        return await db.getChannels(thread.guildId);
      };

      const channels = await handleApiError(null, getChannels, {
        retries: 2,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: `ThreadCreate:getChannels(${thread.guildId})`,
      });

      const auto =
        channels.find((t) => t.id === thread.parentId) ||
        channels.find((t) => t.id === thread.parent?.parentId);

      // Return early if no auto rule is found for the thread's parent or grandparent
      if (!auto) return null;

      const shouldWatch = await handleApiError(null, () => threadShouldBeWatched(auto, thread), {
        retries: 2,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: `ThreadCreate:shouldWatch(${thread.id})`,
      });

      if (shouldWatch) {
        logger.info(`Automatically adding thread "${thread.id}" in ${thread.guildId}`);

        // Use ThreadManager directly for consistency
        await handleApiError(
          null,
          async () => {
            const dueArchive = dueArchiveTimestamp(thread.autoArchiveDuration || 0) as number;

            // Use threadManager directly instead of addThread
            const success = await threadManager.addThreadToWatch(
              thread.id,
              dueArchive,
              thread.guildId
            );

            if (success) {
              logger.done(`Thread "${thread.id}" added successfully in ${thread.guildId}`);
            }
          },
          {
            retries: 2,
            retryDelay: 1000,
            reportAtSeverity: ErrorSeverity.HIGH,
            context: `ThreadCreate:addThread(${thread.id})`,
          }
        );
      } else {
        logger.info(`Not adding thread "${thread.id}" in ${thread.guildId} as filters prevent it`);
      }
    } catch (error) {
      logger.error(
        `Error handling thread creation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  },
};
