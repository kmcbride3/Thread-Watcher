import { readdir } from 'fs/promises';
import { join } from 'path';
import { Client, Events } from 'discord.js';
import { Log76 } from './logger';

/**
 * Dynamically loads all event handlers from the events directory.
 * Enhanced with modern Discord.js events enum validation and better error handling.
 */
export async function loadEvents(client: Client, logger: Log76): Promise<void> {
  try {
    const eventsPath = join(__dirname, '..', 'events');
    const eventFiles = (await readdir(eventsPath)).filter(file => file.endsWith('.js') || file.endsWith('.ts'));
    
    // Keep track of loaded events for debugging
    const loadedEvents: string[] = [];
    const skippedEvents: string[] = [];
    
    // For de-duplication
    const registeredEvents = new Set<string>();
    
    for (const file of eventFiles) {
      try {
        // Import the event module
        const filePath = join(eventsPath, file);
        const eventModule = await import(filePath);
        const event = eventModule.default || eventModule;
        
        if (!event || !event.name || typeof event.execute !== 'function') {
          logger.warn(`Invalid event format in file ${file} - missing name or execute method`);
          skippedEvents.push(`${file} (invalid format)`);
          continue;
        }
        
        // Prevent duplicate registrations
        if (registeredEvents.has(event.name)) {
          logger.warn(`Duplicate event handler for ${event.name} in ${file}, skipping`);
          skippedEvents.push(`${file} (duplicate)`);
          continue;
        }
        
        // Validate event name against Discord.js Events enum
        const validEvent = Object.values(Events).includes(event.name as Events);
        if (!validEvent) {
          logger.warn(`Event ${event.name} in ${file} is not a valid Discord.js event`);
          skippedEvents.push(`${file} (invalid event name)`);
        }
        
        // Register safely with error handling wrapper
        if (event.once) {
          client.once(event.name, async (...args) => {
            try {
              await event.execute(...args);
            } catch (error) {
              logger.error(`Error in event ${event.name}: ${error}`);
            }
          });
        } else {
          client.on(event.name, async (...args) => {
            try {
              await event.execute(...args);
            } catch (error) {
              logger.error(`Error in event ${event.name}: ${error}`);
            }
          });
        }
        
        registeredEvents.add(event.name);
        loadedEvents.push(`${event.name} (${event.once ? 'once' : 'on'})`);
        logger.debug(`Registered ${event.once ? 'one-time' : 'recurring'} event handler for: ${event.name}`);
      } catch (error) {
        logger.error(`Error loading event file ${file}: ${error}`);
        skippedEvents.push(`${file} (error)`);
      }
    }
    
    logger.debug(`Loaded ${loadedEvents.length} events successfully`);
    if (skippedEvents.length > 0) {
      logger.warn(`Skipped ${skippedEvents.length} event files: ${skippedEvents.join(', ')}`);
    }
  } catch (error) {
    logger.error(`Error loading events directory: ${error}`);
    throw error;
  }
}

export default loadEvents;
