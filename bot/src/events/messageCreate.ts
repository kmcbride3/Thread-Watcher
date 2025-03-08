import { Events, Message } from "discord.js";
import { logger } from "../index";
import { threads } from "../bot";
import { bumpAutoTime } from "../utilities/threadActions";

export default {
  name: Events.MessageCreate,
  once: false,
  execute(message: Message) {
    if (message.author.bot) return null;
    if (!message.channel || !message.channel.isThread() || !threads.has(message.channelId))
      return null;
    bumpAutoTime(message.channel).catch((e) => {
      logger.error(`failed to bump thread with id ${message.channelId}: ${e}`);
    });
  },
};
