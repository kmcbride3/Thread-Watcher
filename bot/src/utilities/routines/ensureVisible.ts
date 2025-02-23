import { PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { client, logger, settings, threads } from "../../bot";
import { ThreadData } from "../../interfaces/database";
import { bumpAutoTime, bumpUnknown } from "../threadActions";
import { handleApiError } from "../apiErrorHandler";
import { webLog } from "../../index"; // Import the webLog function

// Helper function for user-friendly summary messaging
function buildEnsureVisibleSummary(summary: {
  worked: number;
  fail_unknown_channel: number;
  fail_could_not_edit: number;
  failed_perms: number;
}): string {
  const lines: string[] = [];
  if (summary.worked > 0) {
    lines.push(`Threads bumped successfully: ${summary.worked}`);
  }
  if (summary.fail_unknown_channel > 0) {
    lines.push(`Channels not found: ${summary.fail_unknown_channel}`);
  }
  if (summary.failed_perms > 0) {
    lines.push(`Missing permissions: ${summary.failed_perms}`);
  }
  if (summary.fail_could_not_edit > 0) {
    lines.push(`Threads failed to update: ${summary.fail_could_not_edit}`);
  }
  return lines.length === 0
    ? "EnsureVisible routine completed with no issues."
    : `EnsureVisible routine completed successfully.\nSummary:\n- ${lines.join("\n- ")}`;
}

// Queue and counter initialization
const queue: ThreadData[] = [];
const summary = {
  worked: 0,
  fail_unknown_channel: 0,
  fail_could_not_edit: 0,
  failed_perms: 0,
};

let running = false;

const makeVisible = () => {
  const t = queue.shift();
  if (!t) return (running = false);
  client.channels
    .fetch(t.id)
    .then(async (thread) => {
      if (!thread?.isThread()) return;

      if (thread.archived && thread.unarchivable) {
        await thread.setArchived(false).catch((err) => {
          handleApiError(err, () => {
            queue.unshift(t);
            makeVisible();
            return Promise.resolve();
          }).catch(() => {
            summary.fail_could_not_edit++;
            webLog("Thread Update Failed", `Failed to unarchive thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`);
          });
        });
      }

      // If user only wants the bot to unarchive the thread without keeping it "active" we can just return here
      if ((await settings.getSetting(thread.guildId, "BEHAVIOUR")) === "UNARCHIVE_ONLY") {
        bumpAutoTime(thread);
        return;
      }

      if (!thread.locked && thread.manageable) {
        /**
         * Previous behaviour was to set the autoarchiveduration to 4320 then directly set it back to 10080.
         * This worked but is not great for ratelimits. This has been changed to setting it to 4320 if it is 10080
         * or setting it to 10080 if it is anything else.
         */
        if (thread.autoArchiveDuration === 10080) {
          await thread.setAutoArchiveDuration(4320).catch((err) => {
            handleApiError(err, () => {
              queue.unshift(t);
              makeVisible();
              return Promise.resolve();
            }).catch(() => {
              summary.fail_could_not_edit++;
              webLog("Thread Update Failed", `Failed to set auto archive duration for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`);
            });
          });
          summary.worked++;
        } else {
          await thread.setAutoArchiveDuration(10080).catch((err) => {
            handleApiError(err, () => {
              queue.unshift(t);
              makeVisible();
              return Promise.resolve();
            }).catch(() => {
              summary.fail_could_not_edit++;
              webLog("Thread Update Failed", `Failed to set auto archive duration for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`);
            });
          });
          summary.worked++;
        }
      } else if (!thread.manageable && thread.sendable && !thread.archived) {
        if (
          thread
            .permissionsFor(thread.client.user.id)
            ?.has(PermissionFlagsBits.EmbedLinks)
        ) {
          const e = new EmbedBuilder().setTitle("Bumping Thread").setFields([
            {
              name: "Why?",
              value:
                "this message is sent to bump activity so this thread does not get hidden.",
            },
            {
              name: "Tired of these messages?",
              value: `give me \`manage threads\` in <#${thread.parentId}>.`,
            },
          ]);
          thread.send({ embeds: [e] }).catch((err) => {
            handleApiError(err, () => {
              queue.unshift(t);
              makeVisible();
              return Promise.resolve();
            }).catch(() => {
              summary.fail_could_not_edit++;
              webLog("Thread Update Failed", `Failed to send bump message for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`);
            });
          });
          summary.worked++;
        } else {
          thread.send(
            `**Bumping thread**\nDon't mind me, I'm just making sure this thread is visible under your channel 👉😎👉\n\n*prefer silent bumps? Give me \`manage threads\` in <#${thread.parentId}>*`,
          ).catch((err) => {
              handleApiError(err, () => {
                queue.unshift(t);
                makeVisible();
                return Promise.resolve();
              }).catch(() => {
                summary.fail_could_not_edit++;
                webLog("Thread Update Failed", `Failed to send bump message for thread "${thread.id}" in channel "${thread.parentId}": ${err.message}`);
              });
            });
          summary.worked++;
        }
      } else {
        summary.failed_perms++;
        webLog("Missing Permissions", `Missing permissions for thread "${thread.id}" in channel "${thread.parentId}"`);
      }

      bumpAutoTime(thread);
    })
    .catch(() => {
      summary.fail_unknown_channel++;
      // We've many unknown channels (probably deleted).
      // (for now) we just "snooze" those for one week but it might be attractive in the future
      // to keep a track of how many revive cycles they've been unknown and pruning when they get
      // over a specific number. Would require a schema change on the db tho

      webLog("Channel Not Found", `Channel not found for thread "${t.id}"`);
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
    if (thread.dueArchive < Date.now() / 1000 && thread.watching) {
      MaybeArchived.push(thread);
    }
  }
  return MaybeArchived;
}

export async function bumpThreadsRoutine(): Promise<void> {
  const needsBump = getPossiblyArchivedThreads([...threads.values()]);
  if (needsBump.length === 0) {
    await logger.info("No threads to bump");
    return;
  }
  logger.info(`Bumping ${needsBump.length} threads`);
  bumpThreads(needsBump);
}
