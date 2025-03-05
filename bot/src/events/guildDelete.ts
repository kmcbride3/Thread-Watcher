import { Events, Guild } from "discord.js";
import { logger } from "../index";
import { clearGuild } from "../utilities/threadActions";

export default {
  name: Events.GuildDelete,
  once: false,
  execute(guild: Guild) {
    logger.info(`Bot removed from guild: ${guild.name} (ID: ${guild.id})`);
    clearGuild(guild.id);
  },
};
