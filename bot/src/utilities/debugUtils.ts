/**
 * Debug utilities for tracking initialization issues
 */

import fs from "fs";
import path from "path";

// Timestamp format helper
const getTimestamp = (): string => {
  return new Date().toISOString();
};

// Utility function to conditionally execute functions based on log level
const executeIfTrace = (fn: () => void): void => {
  if (process.env.LOG_LEVEL === "Trace") {
    fn();
  }
};

// Save initialization state to a file for debugging
export const trackInitState = (state: string): void => {
  executeIfTrace(() => {
    try {
      const debugDir = path.join(process.cwd(), "data");
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      const logFile = path.join(debugDir, "init-debug.log");
      const logMessage = `${getTimestamp()} - PID ${process.pid} - ${state} - ENV:${JSON.stringify({
        IS_SHARD: process.env.IS_SHARD,
        NODE_ENV: process.env.NODE_ENV,
      })}\n`;

      fs.appendFileSync(logFile, logMessage);
    } catch (err) {
      console.error("Failed to write debug log:", err);
    }
  });
};

// Track memory usage
export const logMemoryUsage = (): void => {
  executeIfTrace(() => {
    try {
      const used = process.memoryUsage();
      const debugDir = path.join(process.cwd(), "data");
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      const logFile = path.join(debugDir, "memory-usage.log");
      const logMessage = `${getTimestamp()} - PID ${process.pid} - RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB/${Math.round(used.heapTotal / 1024 / 1024)}MB\n`;

      fs.appendFileSync(logFile, logMessage);
    } catch (err) {
      console.error("Failed to log memory usage:", err);
    }
  });
};
