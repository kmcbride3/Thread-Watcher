import { Client, ClientEvents, Collection } from "discord.js";
import { readdirSync } from "fs";
import path from "path";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import { Log76 } from "./logger";
import { rateLimitManager } from "./rateLimitManager";

/**
 * Interface defining an event module structure
 */
interface EventModule<K extends keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute: (...args: ClientEvents[K]) => Promise<void> | void;
}

// Cache to store loaded events with proper typing
const eventCache = new Collection<string, { default: EventModule<keyof ClientEvents> }>();

/**
 * Loads all event handlers from the events directory
 */
export default async function loadEvents(client: Client, logger: Log76): Promise<void> {
  logger.debug("Loading events...");

  try {
    const eventsPath = path.join(__dirname, "../events");

    // Wait for filesystem rate limit
    await rateLimitManager.waitForRateLimit("fs/readdir");

    // Get event files with error handling
    const eventFiles = await handleApiError(
      "Failed to read events directory",
      // skipcq: JS-0116
      async () => readdirSync(eventsPath).filter((file) => file.endsWith(".js")),
      {
        retries: 2,
        retryDelay: 500,
        reportAtSeverity: ErrorSeverity.HIGH,
        context: "Event Directory Loading",
      }
    );

    // Clear existing event listeners if we're reloading
    const existingEvents = client.eventNames();
    existingEvents.forEach((event) => {
      if (typeof event === "string") {
        client.removeAllListeners(event);
        logger.trace(`Removed existing listeners for event: ${event}`);
      }
    });

    // Track loaded event count for logging
    let loadedCount = 0;
    let skippedCount = 0;

    // Create a list of promises for loading events
    const loadPromises = eventFiles.map(async (file) => {
      // Create a unique rate limit key for each file
      const rateKey = `events/load/${file}`;

      // Wait for rate limit before loading the file
      await rateLimitManager.waitForRateLimit(rateKey);

      return handleApiError(
        `Failed to load event: ${file}`,
        async () => {
          const filePath = path.join(eventsPath, file);

          // Use cache if available, otherwise load file
          let event;

          if (eventCache.has(filePath)) {
            event = eventCache.get(filePath);
            logger.trace(`Using cached event: ${file}`);
          } else {
            // In production, we can safely use require for better performance
            // In development, we may want to clear the cache
            if (process.env.NODE_ENV === "development") {
              const resolvedPath = require.resolve(filePath);
              if (Reflect.has(require.cache, resolvedPath)) {
                Reflect.deleteProperty(require.cache, resolvedPath);
              }
            }

            event = await import(filePath);
            eventCache.set(filePath, event);
          }

          // Get the default export with a null check
          if (!event) {
            logger.warn(`Event file ${file} does not export a valid event configuration`);
            skippedCount++;
            return;
          }
          const { default: eventModule } = event;

          if (!eventModule) {
            logger.warn(`Event file ${file} does not export a default event configuration`);
            skippedCount++;
            return;
          }

          const { name, once, execute } = eventModule;

          if (once) {
            client.once(name, (...args) => execute(...args));
          } else {
            client.on(name, (...args) => execute(...args));
          }

          loadedCount++;
          logger.trace(`Loaded event: ${name} (${file})`);
        },
        {
          retries: 2,
          retryDelay: 500,
          reportAtSeverity: ErrorSeverity.HIGH,
          context: `Event Loading (${file})`,
        }
      );
    });

    await Promise.all(loadPromises);

    logger.debug(
      `Loaded ${loadedCount} event handlers ${skippedCount > 0 ? `(${skippedCount} skipped)` : ""}`
    );

    const registeredEvents = client.eventNames();
    logger.debug(`Registered events: ${registeredEvents.join(", ")}`);
  } catch (error) {
    logger.error(
      `Failed to load events: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}
