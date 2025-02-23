import { ThreadChannel } from "discord.js";
import { logger } from "../bot";
import { addThread, bumpAutoTime, dueArchiveTimestamp, removeThread, setArchive } from "../utilities/threadActions";
import { db, threads } from "../bot";
import { threadShouldBeWatched } from "./threadCreate";

export default function () {
  return async function threadUpdateHandler(oldThread: ThreadChannel, newThread: ThreadChannel): Promise<void> {
    // Safeguard: if guildId is missing, log accordingly.
    if (!newThread || !newThread.guildId) {
      logger.warn("[UNKNOWN INFO] threadUpdate event triggered without guildId.");
      return;
    }

    try {
        const auto = (await db.getChannels(newThread.guildId)).find(t => t.id == newThread.parentId) || (await db.getChannels(newThread.guildId)).find(t => t.id == newThread.parent?.parentId)
        if (auto) {
            const isWatched = threads.has(newThread.id)

            if (await threadShouldBeWatched(auto, newThread)) {
                if (!isWatched) {
                    if (!threads.get(newThread.id)?.watching) return logger.info(`NOT adding thread "${newThread.id}" in ${newThread.guildId} as watched is set to false (TU)`)
                    logger.info(`Automatically adding thread "${newThread.id}" in ${newThread.guildId} (TU)`)
                    addThread(newThread.id, dueArchiveTimestamp(newThread.autoArchiveDuration || 0) as number, newThread.guildId)
                        .catch(err => {
                            logger.error(`could not add thread "${newThread.id}" in ${newThread.guildId}: ${err.toString()}`)
                        })
                }
            } else {
                if (isWatched) {
                    logger.info(`Automatically removing thread "${newThread.id}" in ${newThread.guildId} (TU)`)
                    removeThread(newThread.id)
                }
            }
        }

        if (!threads.has(newThread.id)) return
        if (!newThread.archived && !newThread.locked) {
            bumpAutoTime(newThread)
                .catch((e) => {
                    logger.error(`failed to bump thread with id ${newThread.id}: ${e}`)
                })
            return
        }

        if (!newThread.unarchivable) {
            console.warn(`Skipped "${newThread.id}" in "${newThread.guildId}" as it is not unarchivable`);
            return;
        } else if (newThread.locked) {
            logger.warn(`Skipped "${newThread.id}" in "${newThread.guildId}" as it is locked`);
            return;
        }

        const AUTOARCHIVEDURATION = 10_080;
        setArchive(newThread, AUTOARCHIVEDURATION)
            .then(() => {
                if (newThread.autoArchiveDuration !== AUTOARCHIVEDURATION && newThread.manageable) newThread.setAutoArchiveDuration(AUTOARCHIVEDURATION)
                logger.info(`Unarchived "${newThread.id}" in "${newThread.guildId}"`);
            })
            .catch(err => {
                logger.error(`Failed to unarchive "${newThread.id}" in "${newThread.guildId}\n${err}"`)
            })
    } catch (err) {
        logger.error("Failed threadUpdate event (dump below)")
        console.error(err)
    }
  };
}