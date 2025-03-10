import { Events, ThreadChannel } from "discord.js";
import { db, logger } from "../index";
import { ErrorSeverity, handleApiError } from "../utilities/errorSystem";
import { rateLimitManager } from "../utilities/rateLimitManager";
import {
  addThread,
  bumpAutoTime,
  dueArchiveTimestamp,
  removeThread,
  setArchive,
} from "../utilities/threadActions";
import { threadManager } from "../utilities/threadManager";
import { isThreadChannel, threadShouldBeWatched } from "../utilities/threadUtils";

export default {
  name: Events.ThreadUpdate,
  once: false,
  async execute(oldThread: ThreadChannel, newThread: ThreadChannel) {
    try {
      if (!isThreadChannel(newThread)) {
        logger.warn(`ThreadUpdate received non-thread channel: ${(newThread as ThreadChannel).id}`);
        return null;
      }

      await rateLimitManager.waitForRateLimit(`guilds/${newThread.guildId}/threads`);

      // Check for auto-watch rules
      const getAutoRules = async () => {
        return (
          (await db.getChannels(newThread.guildId)).find((t) => t.id === newThread.parentId) ||
          (await db.getChannels(newThread.guildId)).find((t) => t.id === newThread.parent?.parentId)
        );
      };

      const auto = await handleApiError(null, getAutoRules, {
        retries: 2,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: `ThreadUpdate:getAutoRules(${newThread.id})`,
      });

      const watchedThreads = threadManager.getWatchedThreads();

      if (auto) {
        // Get current watched status
        const isWatched = watchedThreads.has(newThread.id);

        const shouldWatch = await handleApiError(
          null,
          () => threadShouldBeWatched(auto, newThread),
          {
            retries: 2,
            retryDelay: 1000,
            reportAtSeverity: ErrorSeverity.MEDIUM,
            context: `ThreadUpdate:shouldWatch(${newThread.id})`,
          }
        );

        if (shouldWatch) {
          // Thread should be watched per rules
          if (!isWatched) {
            const thread = watchedThreads.get(newThread.id);
            if (thread && !thread.watching) {
              return logger.info(
                `NOT adding thread "${newThread.id}" in ${newThread.guildId} as watched is set to false (TU)`
              );
            }
            logger.info(
              `Automatically adding thread "${newThread.id}" in ${newThread.guildId} (TU)`
            );
            addThread(
              newThread.id,
              dueArchiveTimestamp(newThread.autoArchiveDuration || 0) as number,
              newThread.guildId
            ).catch((err) => {
              logger.error(
                `could not add thread "${newThread.id}" in ${newThread.guildId}: ${err.toString()}`
              );
            });
          }
        } else {
          // Thread should NOT be watched per rules
          if (isWatched) {
            logger.info(
              `Automatically removing thread "${newThread.id}" in ${newThread.guildId} (TU)`
            );
            removeThread(newThread.id);
          }
        }
      }

      // Handle thread maintenance for watched threads
      if (!watchedThreads.has(newThread.id)) return null;

      // If thread is active (not archived/locked), update its due archive time
      if (!newThread.archived && !newThread.locked) {
        bumpAutoTime(newThread).catch((e) => {
          logger.error(`failed to bump thread with id ${newThread.id}: ${e}`);
        });
        return null;
      }

      // Handle special cases
      if (!newThread.unarchivable) {
        // For some reason this line kept breaking???
        logger.warn(
          `Skipped "${newThread.id}" in "${newThread.guildId}" as it is not unarchivable`
        );
        return null;
      } else if (newThread.locked) {
        logger.warn(`Skipped "${newThread.id}" in "${newThread.guildId}" as it is locked`);
        return null;
      }

      /**
       * So, discord hates me and likes to just YOLO deploy thread related stuff which means the bot does not work :(
       * I recon this is due to the new dual states of threads. Threads can be archived and hidden, not archived and not hidden, not archived and hidden.
       * Bot still manages the "archived" state just fine but right now there's no way to explicitly set the "hidden" value.
       */

      const AUTOARCHIVEDURATION = 10_080;
      setArchive(newThread, AUTOARCHIVEDURATION)
        .then(() => {
          if (newThread.autoArchiveDuration !== AUTOARCHIVEDURATION && newThread.manageable) {
            newThread.setAutoArchiveDuration(AUTOARCHIVEDURATION);
          }
          logger.info(`Unarchived "${newThread.id}" in "${newThread.guildId}"`);
        })
        .catch((err) => {
          logger.error(`Failed to unarchive "${newThread.id}" in "${newThread.guildId}\n${err}"`);
        });
    } catch (err) {
      logger.error("Failed threadUpdate event (dump below)");
      logger.error(String(err));
    }
    return null;
  },
};
