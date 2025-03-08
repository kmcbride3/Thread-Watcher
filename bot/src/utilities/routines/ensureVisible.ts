import { PermissionFlagsBits, EmbedBuilder, ThreadChannel } from "discord.js";
import { client, threads, settings } from "../../bot";
import { logger, webLog } from "../../index";
import { ThreadData } from "../../interfaces/database";
import { bumpAutoTime, bumpUnknown } from "../threadActions";
import { handleApiError } from "../apiErrorHandler";
import { setTimeout } from "timers";

// Helper function for user-friendly summary messaging
function buildEnsureVisibleSummary(summary: {
  worked: number;
  fail_unknown_thread: number;
  fail_could_not_edit: number;
  failed_perms: number;
}): string {
  const lines: string[] = [];
  if (summary.worked > 0) {
    lines.push(`Threads bumped successfully: ${summary.worked}`);
  }
  if (summary.fail_unknown_thread > 0) {
    lines.push(`Threads not found: ${summary.fail_unknown_thread}`);
  }
  if (summary.failed_perms > 0) {
    lines.push(`Missing permissions: ${summary.failed_perms}`);
  }
  if (summary.fail_could_not_edit > 0) {
    lines.push(`Threads failed to update: ${summary.fail_could_not_edit}`);
  }

  if (lines.length === 0) {
    return "Thread bumping completed with no activity.";
  } else {
    return `Thread bumping completed.\nSummary:\n- ${lines.join("\n- ")}`;
  }
}

// Queue and counter initialization
const queue: ThreadData[] = [];
const summary = {
  worked: 0,
  fail_unknown_thread: 0,
  fail_could_not_edit: 0,
  failed_perms: 0,
};

let running = false;

const handleError = async (
  err: {
    status?: number;
    code?: number;
    message: string;
    headers?: Record<string, string>;
  },
  retryFunction: () => Promise<void>
) => {
  const error = {
    statusCode: err.status || err.code || 500,
    message: err.message,
    headers: err.headers,
  };
  await handleApiError(error, retryFunction);
};

const makeVisible = () => {
  const t = queue.shift();
  if (!t) return (running = false);
  client.channels
    .fetch(t.id)
    .then(async (channel) => {
      if (!channel || !channel.isThread()) return null;
      const thread = channel as ThreadChannel;
      if (!thread?.isThread()) return null;

      if (thread.archived && thread.unarchivable) {
        await thread.setArchived(false).catch(async (err: Error) => {
          await handleError(err, async () => {
            queue.unshift(t);
            makeVisible();
            return Promise.resolve();
          }).catch(() => {
            summary.fail_could_not_edit++;
            webLog(
              "Thread Update Failed",
              `Failed to unarchive thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`
            );
          });
        });
      }

      // If user only wants the bot to unarchive the thread without keeping it "active" we can just return here
      if ((await settings.getSetting(thread.guildId, "BEHAVIOUR")) === "UNARCHIVE_ONLY") {
        bumpAutoTime(thread);
        return null;
      }

      if (!thread.locked && thread.manageable) {
        /**
         * Previous behaviour was to set the autoarchiveduration to 4320 then directly set it back to 10080.
         * This worked but is not great for ratelimits. This has been changed to setting it to 4320 if it is 10080
         * or setting it to 10080 if it is anything else.
         */
        if (thread.autoArchiveDuration === 10080) {
          await thread.setAutoArchiveDuration(4320).catch(async (err: Error) => {
            await handleError(err, async () => {
              queue.unshift(t);
              makeVisible();
              return Promise.resolve();
            }).catch(() => {
              summary.fail_could_not_edit++;
              webLog(
                "Thread Update Failed",
                `Failed to set auto archive duration for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`
              );
            });
          });
          summary.worked++;
        } else {
          await thread.setAutoArchiveDuration(10080).catch(async (err: Error) => {
            await handleError(err, async () => {
              queue.unshift(t);
              makeVisible();
              return Promise.resolve();
            }).catch(() => {
              summary.fail_could_not_edit++;
              webLog(
                "Thread Update Failed",
                `Failed to set auto archive duration for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`
              );
            });
          });
          summary.worked++;
        }
      } else if (!thread.manageable && thread.sendable && !thread.archived) {
        if (thread.permissionsFor(thread.client.user.id)?.has(PermissionFlagsBits.EmbedLinks)) {
          const e = new EmbedBuilder().setTitle("Bumping Thread").setFields([
            {
              name: "Why?",
              value: "this message is sent to bump activity so this thread does not get hidden.",
            },
            {
              name: "Tired of these messages?",
              value: `give me \`manage threads\` in <#${thread.parentId}>.`,
            },
          ]);
          thread.send({ embeds: [e] }).catch(async (err: Error) => {
            await handleError(err, async () => {
              queue.unshift(t);
              makeVisible();
              return Promise.resolve();
            }).catch(() => {
              summary.fail_could_not_edit++;
              webLog(
                "Thread Update Failed",
                `Failed to send bump message for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`
              );
            });
          });
          summary.worked++;
        } else {
          thread
            .send(
              `**Bumping thread**\nDon't mind me, I'm just making sure this thread is visible under your channel 👉😎👉\n\n*prefer silent bumps? Give me \`manage threads\` in <#${thread.parentId}>*`
            )
            .catch(async (err: Error) => {
              await handleError(err, async () => {
                queue.unshift(t);
                makeVisible();
                return Promise.resolve();
              }).catch(() => {
                summary.fail_could_not_edit++;
                webLog(
                  "Thread Update Failed",
                  `Failed to send bump message for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`
                );
              });
            });
          summary.worked++;
        }
      } else {
        summary.failed_perms++;
        webLog(
          "Missing Permissions",
          `Missing permissions for thread "${thread.id}" in channel "${thread.parentId}"`
        );
      }

      bumpAutoTime(thread);
    })
    .catch(() => {
      summary.fail_unknown_thread++;
      // We've many unknown threads (probably deleted).
      // (for now) we just "snooze" those for one week but it might be attractive in the future
      // to keep a track of how many revive cycles they've been unknown and pruning when they get
      // over a specific number. Would require a schema change on the db tho

      webLog("Thread Not Found", `Thread with ID "${t.id}" could not be found`);
      bumpUnknown(t.id);
    });

  if (queue.length !== 0) setTimeout(makeVisible, 1000 / 4);
  else {
    running = false;
    const finalMsg = buildEnsureVisibleSummary(summary);
    logger.done(finalMsg);
  }
};

export default function bumpThreads(t: ThreadData[]) {
  queue.push(...t);
  if (!running) {
    running = true;
    makeVisible();
  }
}

/**
 * @description Given an array of threads this function will return threads whos dueArchive property is in the past
 * @param threads
 */
export function getPossiblyArchivedThreads(threads: ThreadData[]) {
  const MaybeArchived: ThreadData[] = [];
  for (const thread of threads) {
    if ((thread.dueArchive ?? 0) < Date.now() / 1000 && thread.watching) {
      MaybeArchived.push(thread);
    }
  }
  return MaybeArchived;
}

export async function bumpThreadsRoutine(): Promise<void> {
  const needsBump = getPossiblyArchivedThreads(
    [...threads.values()].map((thread) => ({
      id: thread.id,
      server: thread.server,
      watching: thread.watching,
      dueArchive: thread.dueArchive ?? 0,
    }))
  );
  if (needsBump.length === 0) {
    await logger.info("No threads to bump");
    return;
  }
  logger.info(`Starting thread bumping process for ${needsBump.length} threads`);
  bumpThreads(needsBump);
}
