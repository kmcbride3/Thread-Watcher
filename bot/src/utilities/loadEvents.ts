import { Client } from "discord.js";
import { readdirSync } from "fs";

export default async function loadEvents(
  client: Client,
  deps: { manager: import("discord.js").ShardingManager },
  refresh = false
) {
  readdirSync("./dist/events").forEach(async (file) => {
    if (file.endsWith(".js")) {
      const eventName = file.split(".")[0];
      if (refresh) client.removeAllListeners(eventName);
      if (!client.listenerCount(eventName)) {
        const eventModule = await import(`../events/${file}`);
        if (typeof eventModule.default !== "function") {
          // Log a warning if the default export is not a function
          console.warn(`Event file ${file} does not export a valid function.`);
          return;
        }
        const handler = eventModule.default(deps);
        // Make sure the handler is still a function
        if (typeof handler === "function") {
          client.on(eventName, handler);
        } else {
          console.warn(`Event file ${file} returned an invalid listener.`);
        }
      }
    }
  });
}
