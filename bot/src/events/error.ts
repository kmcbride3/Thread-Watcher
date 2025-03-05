import { Events } from "discord.js";
import { logger } from "../index";

export default {
  name: Events.Error,
  once: false,
  execute(error: Error) {
    logger.error(`Discord client error: ${error.message}`);
    logger.error(error.stack || "No stack trace available");
  }
}