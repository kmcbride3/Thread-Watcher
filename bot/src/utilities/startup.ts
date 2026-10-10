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
let lockSystemEnabled = true

/**
 * Get the lock directory path
 */
export function getLockDirectory(): string {
  return LOCK_DIR
}

/**
 * Check if the process has write permissions to a directory
 */
function hasWritePermissions(dirPath: string): boolean {
  const testFile = path.join(dirPath, `.permission_test_${Date.now()}`)
  let writeSucceeded = false

  try {
    // Create a test file to verify write access
    fs.writeFileSync(testFile, "test", { mode: 0o600 })
    writeSucceeded = true
  } catch {
    return writeSucceeded
  } finally {
    try {
      fs.unlinkSync(testFile)
    } catch (cleanupError) {
      safeLog(
        "debug",
        `Failed to remove permission test file ${testFile}: ${cleanupError}`,
        "STARTUP"
      )
    }
  }

  return writeSucceeded
}

/**
 * Create directories needed for process locks
 * @returns True if directories were created successfully and are writable
 */
function ensureLockDirectoryExists(): boolean {
  try {
    // Use the type-safe enum version instead of string paths
    ensureDirectoryExists(SafeDirectoryPath.DATA_LOCKS);

    // Verify we can actually write to this directory
    if (!hasWritePermissions(LOCK_DIR)) {
      safeLog("warn", `No write permissions for lock directory: ${LOCK_DIR}`, "STARTUP")

      // Try to detect if we're in a container
      const isContainer =
        process.env.CONTAINER === "true" ||
        fs.existsSync("/.dockerenv") ||
        fs.existsSync("/run/.containerenv")

      if (isContainer) {
        safeLog("info", "Running in container environment, lock files are optional", "STARTUP")
        lockSystemEnabled = false
        return false
      } else {
        safeLog("warn", "Lock files disabled due to permission issues", "STARTUP")
        lockSystemEnabled = false
        return false
      }
    }

    return true;
  } catch (error) {
    safeLog("error", `Failed to create lock directory: ${error}`, "STARTUP");
    lockSystemEnabled = false
    return false;
  }
}

/**
 * Check if a process is still running
 * @param pid Process ID to check
 * @returns True if the process is running
 */
export function isPidRunning(pid: number): boolean {
  try {
    // The signal 0 doesn't actually send a signal but checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write to a lock file with proper error handling
 */
function writeLockFile(filePath: string, pid: number): boolean {
  try {
    fs.writeFileSync(filePath, pid.toString(), { mode: 0o600 })

    // Verify the file was actually created
    if (!fs.existsSync(filePath)) {
      safeLog(
        "warn",
        `Failed to create lock file: ${filePath} (file does not exist after write)`,
        "STARTUP"
      )
      return false
    }

    // Keep the lock file readable and writable only by its owner
    try {
      fs.chmodSync(filePath, 0o600)
    } catch (chmodErr) {
      safeLog("debug", `Couldn't set permissions on ${filePath}: ${chmodErr}`, "STARTUP")
      // Non-fatal error
    }

    return true
  } catch (writeError) {
    safeLog("warn", `Failed to write lock file ${filePath}: ${writeError}`, "STARTUP")
    return false
  }
}

/**
 * Create a lock file for the main process
 * @returns True if lock was successfully created
 */
export function createMainProcessLock(): boolean {
  if (!ensureLockDirectoryExists() || !lockSystemEnabled) {
    // If we're in a container environment where lock files are optional
    if (lockSystemEnabled === false) {
      safeLog("debug", "Lock file system disabled, proceeding without lock files", "STARTUP")
      return true
    }

    safeLog("error", "Cannot create main process lock due to directory issues", "STARTUP")
    return false
  }

  try {
    const mainPid = process.pid;

    // Check if lock file exists
    if (fs.existsSync(MAIN_LOCK_FILE)) {
      // Read PID from lock file
      try {
        const lockContent = fs.readFileSync(MAIN_LOCK_FILE, "utf-8")
        const pid = parseInt(lockContent.trim(), 10);

        // For container environments, handle PID 1 specially
        if (pid === 1 && process.pid === 1) {
          // In containerized environments, the bot might always run as PID 1
          // Check if the process has just restarted by examining lock file age
          const stats = fs.statSync(MAIN_LOCK_FILE)
          const fileAgeMs = Date.now() - stats.mtimeMs

          // If the lock file is older than 30 seconds, assume the previous process
          // is no longer running and overwrite the lock
          if (fileAgeMs > 30000) {
            safeLog(
              "debug",
              `Lock file for PID 1 is stale (${Math.round(fileAgeMs / 1000)}s old), replacing it`,
              "STARTUP"
            )
            if (writeLockFile(MAIN_LOCK_FILE, mainPid)) {
              return true
            } else {
              safeLog("error", "Failed to update main process lock for PID 1", "STARTUP")
              return false
            }
          }

          // If we're in a special testing mode, allow multiple PID 1 instances
          if (process.env.ALLOW_MULTIPLE_INSTANCES === "true") {
            safeLog(
              "warn",
              "Multiple instance mode enabled - ignoring existing lock file",
              "STARTUP"
            )
            return true
          }

          safeLog(
            "warn",
            "Another instance with PID 1 appears to be active in container",
            "STARTUP"
          )
          return false
        }

        // For non-PID 1 processes, check if the process is still running
        if (pid !== mainPid) {
          try {
            // Check if process is running
            if (isPidRunning(pid)) {
              safeLog(
                "warn",
                `Main process lock exists for PID ${pid} which is still running`,
                "STARTUP"
              )
              return false;
            } else {
              safeLog("warn", `Removing stale lock file main.lock for PID ${pid}`, "STARTUP")
              // Try to remove the stale lock file
              try {
                fs.unlinkSync(MAIN_LOCK_FILE)
              } catch (unlinkErr) {
                safeLog("warn", `Failed to remove stale lock file: ${unlinkErr}`, "STARTUP")
              // If we can't remove, try to overwrite
              }

              if (writeLockFile(MAIN_LOCK_FILE, mainPid)) {
                return true
              } else {
                safeLog("error", "Failed to update main process lock", "STARTUP")
                return false
              }
            }
          } catch (processCheckError) {
            // If we can't check if the process is running, try to overwrite the lock
            safeLog(
              "warn",
              `Error checking if PID ${pid} is running: ${processCheckError}`,
              "STARTUP"
            )
            if (writeLockFile(MAIN_LOCK_FILE, mainPid)) {
              return true
            } else {
              safeLog("error", "Failed to update main process lock", "STARTUP")
              return false
            }
          }
        }
      } catch (readError) {
        // If we can't read the lock file, try to remove it
        safeLog("warn", `Error reading main lock file: ${readError}`, "STARTUP")
        try {
          fs.unlinkSync(MAIN_LOCK_FILE);
        } catch (unlinkErr) {
          safeLog("warn", `Failed to remove corrupted lock file: ${unlinkErr}`, "STARTUP")
          // If we can't remove, try to overwrite
        }

        // Try to create a new lock file
        if (writeLockFile(MAIN_LOCK_FILE, mainPid)) {
          return true
        } else {
          safeLog("error", "Failed to create main process lock", "STARTUP")
          return false
        }
      }
    } else {
      // No lock file exists, create one
      if (writeLockFile(MAIN_LOCK_FILE, mainPid)) {
        safeLog("trace", `Created main process lock for PID ${mainPid}`, "STARTUP")
        return true
      } else {
        safeLog("error", "Failed to create main process lock", "STARTUP")
        return false
      }
    }

    // If we get here with a matching PID, the lock file exists and has our PID
    return true;
  } catch (error) {
    safeLog("error", `Error creating main process lock: ${error}`, "STARTUP");
    return false;
  }
}

/**
 * Create a lock file for a shard process
 * @param shardId The ID of this shard
 * @returns True if lock was successfully created
 */
export function createShardProcessLock(shardId: number): boolean {
  if (!ensureLockDirectoryExists() || !lockSystemEnabled) {
    if (lockSystemEnabled === false) {
      safeLog("debug", "Lock file system disabled, proceeding without shard lock files", "STARTUP")
      return true
    }

    safeLog("error", `Cannot create Shard ${shardId} lock due to directory issues`, "STARTUP")
    return false
  }

  const lockFile = path.join(LOCK_DIR, `${SHARD_LOCK_PREFIX}${shardId}.lock`);
  const currentPid = process.pid;

  try {
    // Check if lock file exists
    if (fs.existsSync(lockFile)) {
      try {
        // Read the PID from the lock file
        const lockContent = fs.readFileSync(lockFile, "utf-8")
        const pid = parseInt(lockContent.trim(), 10);

        // Check if process is still running and it's not our process
        if (!isNaN(pid) && pid !== currentPid && isPidRunning(pid)) {
          safeLog(
            "warn",
            `Shard ${shardId} lock exists for PID ${pid} which is still running`,
            "STARTUP"
          )
          return false
        }

        // Process not running or it's our own PID, remove/overwrite the lock
        safeLog("warn", `Removing stale Shard ${shardId} lock for PID ${pid}`, "STARTUP")
        try {
          fs.unlinkSync(lockFile);
        } catch (unlinkErr) {
          safeLog("warn", `Failed to remove stale shard lock file: ${unlinkErr}`, "STARTUP")
          // Continue to try overwriting
        }
      } catch (readError) {
        // If we can't read the file, try to remove it
        safeLog("warn", `Error reading Shard ${shardId} lock file: ${readError}`, "STARTUP")
        try {
          fs.unlinkSync(lockFile)
        } catch (unlinkErr) {
          safeLog("warn", `Failed to remove corrupted shard lock file: ${unlinkErr}`, "STARTUP")
          // Continue to try overwriting
        }
      }
    }

    // Create new lock file with current PID
    if (writeLockFile(lockFile, currentPid)) {
      safeLog("trace", `Created Shard ${shardId} process lock for PID ${currentPid}`, "STARTUP")
      return true;
    } else {
      safeLog("warn", `Failed to write Shard ${shardId} lock file`, "STARTUP")

      // In a container, this is less critical - allow to proceed
      if (process.env.CONTAINER === "true" || fs.existsSync("/.dockerenv")) {
        safeLog("info", "Running in container, proceeding without shard lock file", "STARTUP")
        return true
      }

      return false
    }
  } catch (error) {
    safeLog("error", `Failed to create Shard ${shardId} process lock: ${error}`, "STARTUP")

    // In a container, this is less critical - allow to proceed
    if (process.env.CONTAINER === "true" || fs.existsSync("/.dockerenv")) {
      safeLog("info", "Running in container, proceeding without shard lock file", "STARTUP")
      return true
    }

    return false;
  }
}

/**
 * Remove a process lock file
 * @param processType The type of process (main or shard)
 * @param shardId Optional shard ID if removing a shard lock
 */
export function removeProcessLock(processType: ProcessType, shardId?: number): void {
  if (!lockSystemEnabled) {
    return // Skip if lock system is disabled
  }

  try {
    if (processType === ProcessType.MAIN) {
      if (fs.existsSync(MAIN_LOCK_FILE)) {
        fs.unlinkSync(MAIN_LOCK_FILE);
        safeLog("debug", "Removed main process lock", "STARTUP");
      }
    } else if (processType === ProcessType.SHARD && shardId !== undefined) {
      const lockFile = path.join(LOCK_DIR, `${SHARD_LOCK_PREFIX}${shardId}.lock`);
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        safeLog("debug", `Removed Shard ${shardId} process lock`, "STARTUP");
      }
    }
  } catch (error) {
    safeLog("warn", `Failed to remove process lock: ${error}`, "STARTUP")
    // Non-fatal error
  }
}

/**
 * Clean up stale lock files
 */
export function cleanupStaleLocks(): void {
  if (!ensureLockDirectoryExists() || !lockSystemEnabled) {
    return // Skip if directory doesn't exist or lock system is disabled
  }

  try {
    // Check if the lock directory exists
    if (!fs.existsSync(LOCK_DIR)) {
      safeLog("debug", "Lock directory does not exist, skipping cleanup", "STARTUP")
      return
    }

    // Check all files in the lock directory
    const files = fs.readdirSync(LOCK_DIR);

    for (const file of files) {
      // Only process lock files
      if (!file.startsWith(SHARD_LOCK_PREFIX) && file !== "main.lock") {
        continue
      }

      const filePath = path.join(LOCK_DIR, file);

      try {
        // Read the PID from the lock file
        const lockContent = fs.readFileSync(filePath, "utf-8");
        const pid = parseInt(lockContent.trim(), 10);

        // Check if process is still running
        if (isNaN(pid) || !isPidRunning(pid)) {
          safeLog("warn", `Removing stale lock file ${file} for PID ${pid}`, "STARTUP");
          try {
            fs.unlinkSync(filePath);
          } catch (unlinkErr) {
            safeLog("warn", `Failed to remove stale lock file ${file}: ${unlinkErr}`, "STARTUP")
          }
        }
      } catch (readError) {
        // If we can't read the file, try to remove it
        safeLog("warn", `Error reading lock file ${file}, removing: ${readError}`, "STARTUP");
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          safeLog("warn", `Failed to remove invalid lock file ${file}: ${unlinkErr}`, "STARTUP");
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
