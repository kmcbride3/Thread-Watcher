import { Events, ThreadAutoArchiveDuration, ThreadChannel } from "discord.js";
import { logger } from "../index";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { ErrorSeverity, handleApiError } from "../utilities/errorSystem";
import { rateLimitManager } from "../utilities/rateLimitManager";
import { addThread, bumpAutoTime, removeThread, setArchive } from "../utilities/threadActions";
import { threadManager } from "../utilities/threadManager";
import {
  dueArchiveTimestamp,
  isThreadChannel,
  threadShouldBeWatched,
} from "../utilities/threadUtils";

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

      // First handle the thread's watched status based on auto rules
      const isWatched = threadManager.isThreadWatched(newThread.id);

      // Check for auto-watch rules
      const getAutoRules = async () => {
        return await handleApiError(
          null,
          async () => {
            // Use serviceRegistry for safer database access with fallback handling
            const db = serviceRegistry.get(SERVICE_KEYS.DATABASE, {
              errorContext: `ThreadUpdate:getDatabase(${newThread.id})`,
              reportErrors: true,
            });

            const channels = await db.getChannels(newThread.guildId);
            return await (channels.find((t) => t.id === newThread.parentId) ||
              channels.find((t) => t.id === newThread.parent?.parentId));
          },
          {
            retries: 2,
            retryDelay: 1000,
            reportAtSeverity: ErrorSeverity.MEDIUM,
            context: `ThreadUpdate:getAutoRules(${newThread.id})`,
          }
        );
      };

      const auto = await getAutoRules();

      if (auto) {
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
            const thread = threadManager.getWatchedThreads().get(newThread.id);
            if (thread && !thread.watching) {
              return logger.info(
                `NOT adding thread "${newThread.id}" in ${newThread.guildId} as watched is set to false`
              );
            }

            logger.info(`Automatically adding thread "${newThread.id}" in ${newThread.guildId}`);
            await handleApiError(
              null,
              async () => {
                await addThread(
                  newThread.id,
                  dueArchiveTimestamp(newThread.autoArchiveDuration || 0) as number,
                  newThread.guildId
                );
              },
              {
                retries: 2,
                retryDelay: 1000,
                reportAtSeverity: ErrorSeverity.MEDIUM,
                context: `ThreadUpdate:addThread(${newThread.id})`,
              }
            );
          }
        } else {
          // Thread should NOT be watched per rules
          if (isWatched) {
            logger.info(`Automatically removing thread "${newThread.id}" in ${newThread.guildId}`);
            await handleApiError(null, async () => await removeThread(newThread.id), {
              retries: 2,
              retryDelay: 1000,
              reportAtSeverity: ErrorSeverity.MEDIUM,
              context: `ThreadUpdate:removeThread(${newThread.id})`,
            });
          }
        }
      }

      // Then handle thread maintenance if this is a watched thread
      if (!threadManager.isThreadWatched(newThread.id)) return null;

      // If the thread has been archived, unarchive it immediately
      if (newThread.archived && newThread.unarchivable && !newThread.locked) {
        await handleApiError(
          null,
          async () => await setArchive(newThread, ThreadAutoArchiveDuration.OneWeek),
          {
            retries: 2,
            retryDelay: 1000,
            reportAtSeverity: ErrorSeverity.MEDIUM,
            context: `ThreadUpdate:setArchive(${newThread.id})`,
          }
        );
        logger.info(`Unarchived "${newThread.name}" (${newThread.id}) in "${newThread.guildId}"`);
      }
      // Otherwise, if thread is active, update its archive time
      else if (!newThread.archived && !newThread.locked) {
        await handleApiError(null, async () => await bumpAutoTime(newThread), {
          retries: 2,
          retryDelay: 1000,
          reportAtSeverity: ErrorSeverity.LOW,
          context: `ThreadUpdate:bumpAutoTime(${newThread.id})`,
        });
      }

      // Handle special cases with detailed logging
      if (!newThread.unarchivable) {
        logger.warn(
          `Skipped "${newThread.id}" in "${newThread.guildId}" as it is not unarchivable`
        );
      } else if (newThread.locked) {
        logger.warn(`Skipped "${newThread.id}" in "${newThread.guildId}" as it is locked`);
      }
    } catch (err) {
      logger.error(
        `Failed threadUpdate event: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return null;
  },
};
