/**
 * Startup utility functions for managing initialization process
 */
import fs from "fs";
import path from "path";
import os from "os";
import { trackInitState } from "./debugUtils";
import { logger } from "./logger";

// Define our own enum to avoid circular dependencies on ProcessState
export enum ProcessType {
  MAIN = "main",
  SHARD = "shard",
}

// Use temp directory for lock files to avoid file permission issues
const LOCK_DIR = path.join(os.tmpdir(), "thread-watcher-locks");
let initializationLock = false;

type LogLevel = "error" | "warn" | "info" | "debug";

// Safe logger function
const safeLog = (level: LogLevel, message: string): void => {
  // If logger is initialized and has the method, use it
  if (logger && typeof logger[level] === "function") {
    logger[level](message);
  } else {
    // Fallback to console
    const timestamp = new Date().toISOString();
    if (level === "error") {
      console.error(`${timestamp} [ERROR] ${message}`);
    } else if (level === "warn") {
      console.warn(`${timestamp} [WARN] ${message}`);
    } else {
      console.log(`${timestamp} [${level.toUpperCase()}] ${message}`);
    }
  }
};

/**
 * Ensures the lock directory exists
 */
const ensureLockDir = (): void => {
  if (!fs.existsSync(LOCK_DIR)) {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
    } catch (err) {
      safeLog("error", `Failed to create lock directory: ${err}`);
    }
  }
};

/**
 * Ensures initialization only happens once per process
 * @returns True if this is the first initialization, false otherwise
 */
export const acquireInitLock = (): boolean => {
  if (initializationLock) {
    return false;
  }

  initializationLock = true;
  trackInitState("Acquired initialization lock");
  return true;
};

/**
 * Checks if the main process lock exists and is valid
 */
export const checkMainProcessLock = (): boolean => {
  try {
    ensureLockDir();

    const lockFile = path.join(LOCK_DIR, "main-process.lock");
    if (!fs.existsSync(lockFile)) {
      return false;
    }

    const data = fs.readFileSync(lockFile, "utf-8");
    const lockInfo = JSON.parse(data);

    // Check if the process is still running
    try {
      // The kill method with 0 signal doesn't actually kill the process
      // It returns true if the process exists, throws an error otherwise
      process.kill(lockInfo.pid, 0);
      // Process exists, lock is valid
      return true;
    } catch {
      // Process doesn't exist, lock is stale
      logger?.debug?.(`Removing stale main process lock for PID ${lockInfo.pid}`);
      fs.unlinkSync(lockFile);
      return false;
    }
  } catch (err) {
    console.error(`Error checking main process lock: ${err}`);
    return false;
  }
};

/**
 * Creates a main process lock file
 * @returns True if lock was created successfully
 */
export const createMainProcessLock = (): boolean => {
  try {
    ensureLockDir();

    // Check if another process already has the lock
    if (checkMainProcessLock()) {
      console.error("Another main process is already running. This process will exit.");
      return false;
    }

    // Create the lock file
    const lockFile = path.join(LOCK_DIR, "main-process.lock");
    const lockInfo = {
      pid: process.pid,
      started: new Date().toISOString(),
    };

    fs.writeFileSync(lockFile, JSON.stringify(lockInfo, null, 2));
    logger?.debug?.(`Created main process lock for PID ${process.pid}`);

    // Register automatic cleanup on process exit
    process.once("exit", () => removeProcessLock(ProcessType.MAIN));
    process.once("SIGINT", () => removeProcessLock(ProcessType.MAIN));
    process.once("SIGTERM", () => removeProcessLock(ProcessType.MAIN));

    return true;
  } catch (err) {
    console.error(`Failed to create main process lock: ${err}`);
    return false;
  }
};

/**
 * Creates a shard process lock file
 * @param shardId The ID of the shard
 * @returns True if lock was created successfully
 */
export const createShardProcessLock = (shardId: number | string): boolean => {
  try {
    ensureLockDir();

    // Parse shardId if it's a string
    const shardIdStr =
      typeof shardId === "string"
        ? shardId.toString().replace("shard", "").trim()
        : shardId.toString();

    const lockFile = path.join(LOCK_DIR, `shard-${shardIdStr}.lock`);
    const lockInfo = {
      pid: process.pid,
      shardId: shardIdStr,
      started: new Date().toISOString(),
    };

    fs.writeFileSync(lockFile, JSON.stringify(lockInfo, null, 2));
    logger?.debug?.(`Created shard ${shardIdStr} process lock for PID ${process.pid}`);

    // Register automatic cleanup on process exit
    process.once("exit", () =>
      removeProcessLock(ProcessType.SHARD, parseInt(shardIdStr) || Number(shardIdStr))
    );
    process.once("SIGINT", () =>
      removeProcessLock(ProcessType.SHARD, parseInt(shardIdStr) || Number(shardIdStr))
    );
    process.once("SIGTERM", () =>
      removeProcessLock(ProcessType.SHARD, parseInt(shardIdStr) || Number(shardIdStr))
    );

    return true;
  } catch (err) {
    console.error(`Failed to create shard process lock: ${err}`);
    return false;
  }
};

/**
 * Removes the process lock file
 * @param processType The process type (main or shard)
 * @param shardId The shard ID (if processType is SHARD)
 */
export const removeProcessLock = (processType: ProcessType | string, shardId?: number): void => {
  try {
    let lockFile: string;

    if (processType === ProcessType.MAIN || processType === "main") {
      lockFile = path.join(LOCK_DIR, "main-process.lock");
    } else if (
      (processType === ProcessType.SHARD || processType === "shard") &&
      shardId !== undefined
    ) {
      lockFile = path.join(LOCK_DIR, `shard-${shardId}.lock`);
    } else if (typeof processType === "string" && processType.startsWith("shard")) {
      // Handle the old-style parameter format for backward compatibility
      const extractedId = processType.replace("shard", "").trim();
      lockFile = path.join(LOCK_DIR, `shard-${extractedId}.lock`);
    } else {
      console.error(
        `Invalid parameters for removeProcessLock: processType=${processType}, shardId=${shardId}`
      );
      return;
    }

    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      logger?.debug?.(`Removed ${processType} lock file for PID ${process.pid}`);
    }
  } catch (err) {
    console.error(`Failed to remove lock file: ${err}`);
  }
};

/**
 * Check for existing processes and clean up stale locks
 */
export const cleanupStaleLocks = (): void => {
  try {
    ensureLockDir();

    const files = fs.readdirSync(LOCK_DIR);
    for (const file of files) {
      if (file.endsWith(".lock")) {
        const lockFile = path.join(LOCK_DIR, file);
        try {
          const data = fs.readFileSync(lockFile, "utf-8");
          let lockInfo;

          try {
            lockInfo = JSON.parse(data);
          } catch {
            // Invalid JSON, remove the lock file
            fs.unlinkSync(lockFile);
            continue;
          }

          if (!lockInfo.pid) {
            // Invalid lock info, remove the file
            fs.unlinkSync(lockFile);
            continue;
          }

          try {
            // Check if the process is still running
            process.kill(lockInfo.pid, 0);
            // Process exists, lock is valid
          } catch {
            // Process doesn't exist, lock is stale
            fs.unlinkSync(lockFile);
            console.log(`Removed stale lock file for PID ${lockInfo.pid}: ${file}`);
          }
        } catch {
          // Error reading the lock file, remove it
          try {
            fs.unlinkSync(lockFile);
            console.log(`Removed invalid lock file: ${file}`);
          } catch (e) {
            console.error(`Failed to remove invalid lock file ${file}: ${e}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to clean up stale locks: ${err}`);
  }
};

/**
 * Legacy function for backward compatibility
 * @deprecated Use createMainProcessLock or createShardProcessLock instead
 */
export const createProcessLockFile = (processType: string): boolean => {
  if (processType === "main") {
    return createMainProcessLock();
  } else {
    const shardId = processType.replace("shard", "").trim();
    return createShardProcessLock(shardId);
  }
};
