import { GuildBasedChannel, PermissionFlagsBits, ThreadChannel } from "discord.js";
import { botSettings, client, threads } from "../../bot";
import { logger } from "../../index";
import { statusType } from "../../interfaces/command";
import { ThreadData } from "../../interfaces/database";
import { createEmbed } from "../embedUtils";
import { ErrorSeverity, handleApiError } from "../errorSystem";
import { formatArchiveDuration } from "../formatUtils";
import { rateLimitManager } from "../rateLimitManager";
import { bumpAutoTime, bumpUnknown } from "../threadActions";
import { isThreadChannel } from "../threadUtils";

const queue: ThreadData[] = [];
const summary = {
  worked: 0,
  fail_unknown_channel: 0,
  fail_could_not_edit: 0,
  failed_perms: 0,
};

let running = false;

const makeVisible = () => {
  const threadData = queue.shift();
  if (!threadData) return (running = false);

  client.channels
    .fetch(threadData.id)
    .then(async (channel) => {
      if (!channel || !isThreadChannel(channel as GuildBasedChannel)) {
        summary.fail_unknown_channel++;
        bumpUnknown(threadData.id);
        processNextThread();
        return;
      }

      const thread = channel as ThreadChannel;
      const route = `/channels/${thread.id}`;

      try {
        // First, unarchive if needed
        if (thread.archived && thread.unarchivable) {
          await handleApiError(
            `Failed to unarchive thread ${thread.id}`,
            async () => {
              await rateLimitManager.waitForRateLimit(`${route}/archived`);
              await thread.setArchived(false);
            },
            {
              retries: 2,
              retryDelay: 1000,
              reportAtSeverity: ErrorSeverity.MEDIUM,
              context: `Thread Unarchive (${thread.id})`,
            }
          ).catch(() => {
            summary.fail_could_not_edit++;
            logger.error(`Failed to unarchive thread "${thread.id}"`);
            processNextThread();
            return;
          });
        }

        // If user only wants the bot to unarchive the thread without keeping it "active" we can just return here
        const behaviour = botSettings
          ? await botSettings.getSetting(thread.guildId, "BEHAVIOUR")
          : null;
        if (behaviour === "UNARCHIVE_ONLY") {
          await bumpAutoTime(thread);
          processNextThread();
          return;
        }

        if (!thread.locked && thread.manageable) {
          // Set autoArchiveDuration to toggle activity state
          await handleApiError(
            `Failed to update archive duration for thread ${thread.id}`,
            async () => {
              await rateLimitManager.waitForRateLimit(`channels/${thread.id}/auto-archive`);

              if (thread.autoArchiveDuration === 10080) {
                await thread.setAutoArchiveDuration(4320);
                logger.debug(
                  `Set auto-archive duration for thread ${thread.id} to ${formatArchiveDuration(4320)}`
                );
              } else {
                await thread.setAutoArchiveDuration(10080);
                logger.debug(
                  `Set auto-archive duration for thread ${thread.id} to ${formatArchiveDuration(10080)}`
                );
              }
              summary.worked++;
            },
            {
              retries: 2,
              retryDelay: 1000,
              reportAtSeverity: ErrorSeverity.MEDIUM,
              context: `Thread Duration Toggle (${thread.id})`,
            }
          ).catch(() => {
            summary.fail_could_not_edit++;
            processNextThread();
            return;
          });
        } else if (!thread.manageable && thread.sendable && !thread.archived) {
          await handleApiError(
            `Failed to send bump message to thread ${thread.id}`,
            async () => {
              await rateLimitManager.waitForRateLimit(`channels/${thread.id}/messages`);

              if (
                thread
                  .permissionsFor(thread.client.user?.id || "")
                  ?.has(PermissionFlagsBits.EmbedLinks)
              ) {
                const embed = createEmbed("Bumping Thread", statusType.info, {
                  fields: [
                    {
                      name: "Why?",
                      value:
                        "This message is sent to bump activity so this thread does not get hidden.",
                    },
                    {
                      name: "Tired of these messages?",
                      value: `Give me \`manage threads\` in <#${thread.parentId}>.`,
                    },
                  ],
                });
                await thread.send({ embeds: [embed] });
              } else {
                await thread.send(
                  `**Bumping thread**\nDont mind me, I'm just making sure this thread is visible under your channel 👉😎👉\n\n*prefer silent bumps? Give me \`manage threads\` in <#${thread.parentId}>*`
                );
              }
              summary.worked++;
            },
            {
              retries: 2,
              retryDelay: 1000,
              reportAtSeverity: ErrorSeverity.LOW,
              context: `Thread Bump Message (${thread.id})`,
            }
          ).catch(() => {
            summary.fail_could_not_edit++;
            processNextThread();
            return;
          });
        } else {
          summary.failed_perms++;
        }

        await bumpAutoTime(thread);
        processNextThread();
      } catch (err) {
        logger.error(
          `Unexpected error processing thread ${thread.id}: ${err instanceof Error ? err.message : String(err)}`
        );
        summary.fail_could_not_edit++;
        processNextThread();
      }
    })
    .catch(() => {
      summary.fail_unknown_channel++;
      bumpUnknown(threadData.id);
      processNextThread();
    });

  return null;
};

function processNextThread() {
  if (queue.length !== 0) {
    setTimeout(makeVisible, 250); // 4 requests per second
  } else {
    running = false;
    logSummary();
  }
}

function logSummary() {
  const total =
    summary.worked +
    summary.failed_perms +
    summary.fail_unknown_channel +
    summary.fail_could_not_edit;
  const successRate = total > 0 ? ((summary.worked / total) * 100).toFixed(1) : "0.0";

  logger.done(
    `ensureVisible routine completed.\nSummary:\n- worked: ${summary.worked} (${successRate}%)\n- cant get channel: ${summary.fail_unknown_channel}\n- no perms: ${summary.failed_perms}\n- could not edit: ${summary.fail_could_not_edit}`
  );
}

export default function bumpThreads(t: ThreadData[]) {
  queue.push(...t);
  if (!running) {
    running = true;
    makeVisible();
  }
}

/**
 * @description Given an array of threads this function will return threads whose dueArchive property is in the past
 * @param threads
 */
export function getPossiblyArchivedThreads(threads: ThreadData[]) {
  const now = Date.now() / 1000;
  return threads.filter((thread) => thread.watching && thread.dueArchive < now);
}

export function bumpThreadsRoutine(): void {
  const threadArray = [...threads.values()].map((thread) => ({
    id: thread.id,
    server: thread.server,
    watching: thread.watching,
    dueArchive: thread.dueArchive ?? 0,
  }));

  const needsBump = getPossiblyArchivedThreads(threadArray);

  if (needsBump.length === 0) {
    logger.info("No threads to bump");
    return;
  }

  logger.info(`Bumping ${needsBump.length} threads`);
  bumpThreads(needsBump);
}
