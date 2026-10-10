import { CloseEvent, Events } from "discord.js"
import { logger } from "../utilities/logger"

export default {
  name: Events.ShardDisconnect,
  once: false,
  execute(closeEvent: CloseEvent, shardId: number) {
    logger.warn(
      `Shard ${shardId} disconnected: code ${closeEvent.code}, reason: ${closeEvent.reason || "No reason provided"}`
    );
  },
};
