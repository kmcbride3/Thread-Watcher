/**
 * Debug utilities for tracking initialization issues and memory tracking
 */

import { Collection } from "discord.js";
import { EventEmitter } from "events";
import { logger, logToFile } from "./logger";
import { safeRegExp } from "./securityUtils";

// Initialize debug state tracking
const initLog: string[] = [];
const startTime = Date.now();

// Define log filenames - will use the same directory as the main logs
const INIT_LOG_FILE = "initialization.log";
const MEMORY_LOG_FILE = "memory-usage.log";

/**
 * Track initialization state for debugging startup issues
 */
export function trackInitState(message: string): void {
  const timestamp = Date.now();
  const timeFromStart = timestamp - startTime;
  const logEntry = `[${timeFromStart}ms] ${message}`;

  // Add to in-memory buffer
  initLog.push(logEntry);

  // Log to main log with INIT context
  logger.debug(message, "INIT");

  // Log to init-specific log file with timestamp but no additional context
  logToFile(logEntry, INIT_LOG_FILE);
}

/**
 * Write full initialization log to disk
 * Only needed on exit now as we're writing entries continuously
 */
function writeFullInitLog(): void {
  try {
    // Build the full log content
    const fullLog = initLog.join("\n");

    // Use the log function with custom file path
    logger.debug(fullLog, undefined, INIT_LOG_FILE);
  } catch (err) {
    console.error("Failed to write initialization log:", err);
  }
}

/**
 * Log memory usage statistics for debugging memory leaks
 */
export function logMemoryUsage(): void {
  const memUsage = process.memoryUsage();
  const memoryMessage = `RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap: ${Math.round(memUsage.heapUsed / 1024 / 1024)}/${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`;

  // Log to memory-specific log without additional context
  logToFile(memoryMessage, MEMORY_LOG_FILE);
}

/**
 * Log current event listener counts for debugging
 */
export function logEventListenerCounts(emitter: EventEmitter, name: string): void {
  if (process.env.NODE_ENV !== "development") return;

  if (!emitter || !(emitter instanceof EventEmitter)) {
    logger.warn(`Invalid EventEmitter provided to logEventListenerCounts: ${typeof emitter}`);
    return;
  }

  // Validate the name parameter
  if (typeof name !== "string" || !name) {
    logger.warn("Invalid name provided to logEventListenerCounts");
    return;
  }

  const events = emitter.eventNames();

  // Use a Collection instead of direct object property assignment to avoid injection
  const countsCollection = new Collection<string, number>();

  // Validate event names before using them
  const validEventNameRegex = safeRegExp("^[a-zA-Z0-9_:.\\-]+$");

  events.forEach((event) => {
    const eventName = typeof event === "string" ? event : String(event);

    // Ensure the event name is safe to use
    if (validEventNameRegex.test(eventName)) {
      countsCollection.set(eventName, emitter.listenerCount(event));
    } else {
      // Log suspicious event names but don't use them as keys
      logger.warn(
        `Skipping suspicious event name in logEventListenerCounts: ${eventName.slice(0, 32)}...`
      );
    }
  });

  // Only log if there are event listeners
  if (countsCollection.size > 0) {
    // Convert to a safe object for logging
    const countsObject = Object.fromEntries(countsCollection);
    logger.debug(`Event listener counts for ${name}: ${JSON.stringify(countsObject)}`);

    // Create a safe iterator for the high count warning
    countsCollection.forEach((count, event) => {
      if (count > 8) {
        // Warning level before we hit the default max
        logger.warn(`High listener count: ${count} listeners for event '${event}' on ${name}`);
      }
    });
  }
}

// Write init log on process exit
process.on("exit", () => {
  writeFullInitLog();
});
