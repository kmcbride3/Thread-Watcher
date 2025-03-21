import fs from "fs"
import path from "path"
import { safeLog } from "./logger"
import { ensureDirectoryExists, SafeDirectoryPath } from "./securityUtils"

/**
 * Process types for lock files
 */
export enum ProcessType {
  MAIN = "main",
  SHARD = "shard",
}

// Constants for lock files
const LOCK_DIR = path.join(process.cwd(), "data", "locks");
const MAIN_LOCK_FILE = path.join(LOCK_DIR, "main.lock");
const SHARD_LOCK_PREFIX = "shard-";

// Track initialization state
let initLockAcquired = false;

/**
 * Create directories needed for process locks
 */
function ensureLockDirectoryExists(): void {
  try {
    // Use the type-safe enum version instead of string paths
    ensureDirectoryExists(SafeDirectoryPath.DATA_LOCKS);
  } catch (error) {
    safeLog("error", `Failed to create lock directory: ${error}`, "STARTUP");
  }
}

/**
 * Check if a process is still running
 * @param pid Process ID to check
 * @returns True if the process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    // The signal 0 doesn't actually send a signal but checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a lock file for the main process
 * @returns True if lock was successfully created
 */
export function createMainProcessLock(): boolean {
  ensureLockDirectoryExists();

  try {
    // Check if lock file exists
    if (fs.existsSync(MAIN_LOCK_FILE)) {
      // Read the PID from the lock file
      const lockContent = fs.readFileSync(MAIN_LOCK_FILE, "utf-8");
      const pid = parseInt(lockContent.trim(), 10);

      // Check if process is still running
      if (!isNaN(pid) && isProcessRunning(pid)) {
        safeLog(
          "warn",
          `Main process lock exists for PID ${pid} which is still running`,
          "STARTUP"
        );
        return false;
      }

      // Process not running, remove stale lock
      safeLog("trace", `Removing stale main process lock for PID ${pid}`, "STARTUP");
      fs.unlinkSync(MAIN_LOCK_FILE);
    }

    // Create new lock file with current PID
    fs.writeFileSync(MAIN_LOCK_FILE, process.pid.toString(), { mode: 0o644 });
    safeLog("trace", `Created main process lock for PID ${process.pid}`, "STARTUP");
    return true;
  } catch (error) {
    safeLog("error", `Failed to create main process lock: ${error}`, "STARTUP");
    return false;
  }
}

/**
 * Create a lock file for a shard process
 * @param shardId The ID of this shard
 * @returns True if lock was successfully created
 */
export function createShardProcessLock(shardId: number): boolean {
  ensureLockDirectoryExists();
  const lockFile = path.join(LOCK_DIR, `${SHARD_LOCK_PREFIX}${shardId}.lock`);

  try {
    // Check if lock file exists
    if (fs.existsSync(lockFile)) {
      // Read the PID from the lock file
      const lockContent = fs.readFileSync(lockFile, "utf-8");
      const pid = parseInt(lockContent.trim(), 10);

      // Check if process is still running
      if (!isNaN(pid) && isProcessRunning(pid)) {
        safeLog(
          "warn",
          `Shard ${shardId} lock exists for PID ${pid} which is still running`,
          "STARTUP"
        );
        return false;
      }

      // Process not running, remove stale lock
      safeLog("warn", `Removing stale shard ${shardId} lock for PID ${pid}`, "STARTUP");
      fs.unlinkSync(lockFile);
    }

    // Create new lock file with current PID
    fs.writeFileSync(lockFile, process.pid.toString(), { mode: 0o644 });
    safeLog("trace", `Created shard ${shardId} process lock for PID ${process.pid}`, "STARTUP");
    return true;
  } catch (error) {
    safeLog("error", `Failed to create shard ${shardId} process lock: ${error}`, "STARTUP");
    return false;
  }
}

/**
 * Remove a process lock file
 * @param processType The type of process (main or shard)
 * @param shardId Optional shard ID if removing a shard lock
 */
export function removeProcessLock(processType: ProcessType, shardId?: number): void {
  ensureLockDirectoryExists();

  try {
    if (processType === ProcessType.MAIN) {
      if (fs.existsSync(MAIN_LOCK_FILE)) {
        fs.unlinkSync(MAIN_LOCK_FILE);
        safeLog("debug", `Removed main process lock`, "STARTUP");
      }
    } else if (processType === ProcessType.SHARD && shardId !== undefined) {
      const lockFile = path.join(LOCK_DIR, `${SHARD_LOCK_PREFIX}${shardId}.lock`);
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        safeLog("debug", `Removed shard ${shardId} process lock`, "STARTUP");
      }
    }
  } catch (error) {
    safeLog("error", `Failed to remove process lock: ${error}`, "STARTUP");
  }
}

/**
 * Clean up stale lock files
 */
export function cleanupStaleLocks(): void {
  ensureLockDirectoryExists();

  try {
    // Check all files in the lock directory
    const files = fs.readdirSync(LOCK_DIR);

    for (const file of files) {
      const filePath = path.join(LOCK_DIR, file);

      try {
        // Read the PID from the lock file
        const lockContent = fs.readFileSync(filePath, "utf-8");
        const pid = parseInt(lockContent.trim(), 10);

        // Check if process is still running
        if (isNaN(pid) || !isProcessRunning(pid)) {
          safeLog("warn", `Removing stale lock file ${file} for PID ${pid}`, "STARTUP");
          fs.unlinkSync(filePath);
        }
      } catch (readError) {
        // If we can't read the file, try to remove it
        safeLog("warn", `Error reading lock file ${file}, removing: ${readError}`, "STARTUP");
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore errors removing invalid lock files
        }
      }
    }
  } catch (error) {
    safeLog("error", `Failed to cleanup stale locks: ${error}`, "STARTUP");
  }
}

/**
 * Acquire a single initialization lock to prevent multiple init calls
 * @returns True if this is the first initialization, false otherwise
 */
export function acquireInitLock(): boolean {
  if (initLockAcquired) {
    return false;
  }

  initLockAcquired = true;
  return true;
}
