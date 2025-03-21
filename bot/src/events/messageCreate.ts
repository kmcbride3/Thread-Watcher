import { Events, Message } from "discord.js";
import { logger } from "../index";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { bumpAutoTime } from "../utilities/threadActions";

export default {
  name: Events.MessageCreate,
  once: false,
  execute(message: Message) {
    if (message.author.bot) return null;
    if (!message.channel || !message.channel.isThread()) return null;

    if (!serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      return null;
    }

    const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
    const threads = threadManager.getWatchedThreads();

    if (!threads.has(message.channelId)) return null;

    bumpAutoTime(message.channel).catch((e) => {
      logger.error(`failed to bump thread with id ${message.channelId}: ${e}`);
    });

    return Promise.resolve();
  },
};
