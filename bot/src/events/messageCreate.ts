import { Events, Message } from "discord.js"
import { SERVICE_KEYS, serviceRegistry } from "../services"
import { logger } from "../utilities/logger"
import { bumpAutoTime } from "../utilities/threadActions"

export default {
  name: Events.MessageCreate,
  once: false,
  async execute(message: Message) {
    if (message.author.bot) return null;
    if (!message.channel || !message.channel.isThread()) return null;

    if (!serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      return null;
    }

    const threadManager = await serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
    const threads = threadManager.getWatchedThreads();

    if (!threads.has(message.channelId)) return null;

    bumpAutoTime(message.channel).catch((e) => {
      logger.error(`failed to bump thread with id ${message.channelId}: ${e}`);
    });

    return Promise.resolve();
  },
};
