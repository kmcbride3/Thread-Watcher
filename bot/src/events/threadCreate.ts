import { Events, ThreadChannel } from "discord.js";
import { db, logger } from "../index";
import { addThread, dueArchiveTimestamp } from "../utilities/threadActions";
import { strToRegex } from "../utilities/regex";
import { ChannelData } from "../interfaces/database";

export function regMatch(str: string, reg: RegExp, inverted: boolean) {
  return reg.test(str) === !inverted;
}

export async function threadShouldBeWatched(auto: ChannelData, thread: ThreadChannel) {
  auto.roles = auto.roles.filter((s) => !(s?.trim() == ""));
  auto.tags = auto.tags.filter((s) => !(s?.trim() == ""));
  const reg = auto.regex.length != 0 ? strToRegex(auto.regex) : false;
  let passes = true;

  if (thread.locked) return false;

  if (auto.roles && auto.roles.length !== 0) {
    let rolePasses = false;
    for (const role of auto.roles) {
      const owner = thread.ownerId
        ? await thread.guild.members.fetch({ force: true, user: thread.ownerId }).catch((error) => {
            logger.error(`Failed to fetch thread owner: ${error}`);
          })
        : null;
      if (!role) break;
      if (owner?.roles.cache.has(role)) rolePasses = true;
    }
    if (!rolePasses) passes = false;
  }

  if (auto.tags && auto.tags.length !== 0) {
    let tagPasses = false;
    for (const tag of auto.tags) {
      if (!tag) break;
      if (thread.appliedTags.includes(tag)) tagPasses = true;
    }
    if (!tagPasses) passes = false;
  }

  if (reg) {
    if (!regMatch(thread.name, reg.regex, reg.inverted)) {
      passes = false;
    }
  }

  return passes;
}

export default {
  name: Events.ThreadCreate,
  once: false,
  async execute(thread: ThreadChannel) {
    const channels = await db.getChannels(thread.guildId);
    const auto =
      channels.find((t) => t.id == thread.parentId) ||
      channels.find((t) => t.id == thread.parent?.parentId);

    // Return early if no auto rule is found for the thread's parent or grandparent
    if (!auto) return;

    if (await threadShouldBeWatched(auto, thread)) {
      logger.info(`Automatically adding thread "${thread.id}" in ${thread.guildId}`);
      addThread(
        thread.id,
        dueArchiveTimestamp(thread.autoArchiveDuration || 0) as number,
        thread.guildId
      )
        .then(() => {
          logger.done(`Thread "${thread.id}" added successfully in ${thread.guildId}`);
        })
        .catch((err) => {
          logger.error(`could not add thread "${thread.id}" in ${thread.guildId}: ${err.message}`);
        });
    } else {
      logger.info(`Not adding thread "${thread.id}" in ${thread.guildId} as filters prevent it`);
    }
  },
};
