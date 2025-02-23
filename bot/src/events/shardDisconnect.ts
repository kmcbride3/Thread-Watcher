import { Shard, ShardingManager } from "discord.js";
import { logger } from "../bot";

export default function ({ manager }: { manager: ShardingManager }) {
  return function (shardId: number): void {
    logger.warn(`Shard ${shardId} disconnected. Attempting to respawn that shard...`);
    const shardInstance = manager.shards.get(shardId) as Shard;
    if (shardInstance && typeof shardInstance.respawn === "function") {
      shardInstance.respawn();
    }
  };
}