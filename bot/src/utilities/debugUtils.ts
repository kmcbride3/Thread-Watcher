/**
 * Debug utilities for tracking initialization issues and memory tracking
 */

import { logger, logToFile } from "./logger";

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

// Write init log on process exit
process.on("exit", () => {
  writeFullInitLog();
});
