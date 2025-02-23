import { Client } from "discord.js";
import { readdirSync } from "fs";

/**
 *
 * @param client The client to register the events on.
 * @param refresh removes old listener if set to true
 */
export default function loadEvents(
  client: Client,
  deps: { manager: import("discord.js").ShardingManager },
  refresh = false
) {
  readdirSync("./dist/events").forEach(async (file) => {
    if (file.endsWith(".js")) {
      const eventName = file.split(".")[0];
      if (refresh) client.removeAllListeners(eventName);
      if (!client.listenerCount(eventName)) {
        const eventFactory = (await import(`../events/${file}`)).default;
        const handler = eventFactory(deps);
        client.on(eventName, handler);
      }
    }
  });
}
