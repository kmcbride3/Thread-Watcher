import { Events, ThreadChannel } from "discord.js";
import { db, logger } from "../index";
import { ErrorSeverity, handleApiError } from "../utilities/errorSystem";
import { rateLimitManager } from "../utilities/rateLimitManager";
import { addThread, dueArchiveTimestamp } from "../utilities/threadActions";
import { isThreadChannel, threadShouldBeWatched } from "../utilities/threadUtils";

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

      const getChannels = async () => await db.getChannels(thread.guildId);
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

        await handleApiError(
          null,
          async () => {
            await addThread(
              thread.id,
              dueArchiveTimestamp(thread.autoArchiveDuration || 0) as number,
              thread.guildId
            );
            logger.done(`Thread "${thread.id}" added successfully in ${thread.guildId}`);
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
