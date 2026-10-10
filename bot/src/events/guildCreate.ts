import { Events, Guild } from "discord.js"
import { SERVICE_KEYS, serviceRegistry } from "../services"
import { logger } from "../utilities/logger"
import { threadManager } from "../utilities/threadManager"

export default {
  name: Events.GuildCreate,
  once: false,
  async execute(guild: Guild) {
    try {
      logger.info(`Bot joined server: ${guild.name} (${guild.id})`);

      // Only check for threads if we have the database service available
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        logger.debug(
          `Database not available when joining guild ${guild.id}, skipping thread check`
        );
        return;
      }

      // Get database instance
      const db = await serviceRegistry.get(SERVICE_KEYS.DATABASE);

      // Check if we already have threads or channels for this server
      const [threads, channels] = await Promise.all([
        db.getThreads(guild.id),
        db.getChannels(guild.id),
      ]);

      // Only perform maintenance if we have existing watched content
      const hasWatchedContent =
        (threads && threads.some((thread) => thread.watching)) || (channels && channels.length > 0);

      if (hasWatchedContent) {
        logger.info(
          `Found existing watched content in server ${guild.name} (${guild.id}), performing maintenance`
        );
        // Check for threads that need maintenance in this server
        await threadManager.checkThreadsForServer(guild.id);
      } else {
        logger.debug(
          `No existing watched content in server ${guild.name} (${guild.id}), skipping maintenance`
        );
      }
    } catch (error) {
      logger.error(`Error handling guild join for ${guild.id}: ${error}`);
    }
  },
};
