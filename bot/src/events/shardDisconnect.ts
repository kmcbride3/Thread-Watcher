import { Events, CloseEvent } from "discord.js";
import { logger } from "../index";

export default {
  name: Events.ShardDisconnect,
  once: false,
  execute(closeEvent: CloseEvent, shardId: number) {
    logger.warn(
      `Shard ${shardId} disconnected: code ${closeEvent.code}, reason: ${closeEvent.reason || "No reason provided"}`
    );
  },
};
