import { Client } from "discord.js";
import { logger } from "../bot";

export default function(client: Client) {
  logger.warn(`Shard ${client.shard?.ids[0]} disconnected. Attempting to reconnect...`);
  client.destroy().then(() => client.login());
}