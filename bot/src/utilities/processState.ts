/**
 * Process state tracking for master/shard differentiation
 */

// Track process roles and initialization state
export enum ProcessRole {
  MAIN = "main",
  SHARD = "shard",
  UNKNOWN = "unknown",
}

export interface ProcessState {
  role: ProcessRole;
  shardId?: number;
  isInitialized: boolean;
}

export const processState: ProcessState = {
  role: ProcessRole.UNKNOWN,
  isInitialized: false,
};

/**
 * Determine if the current process is a shard
 * @returns boolean indicating if the current process is a shard
 */
export function isShard(): boolean {
  // Check for the environment variable first (most reliable)
  if (process.env.IS_SHARD === "true") {
    return true;
  }

  // Check command line arguments for the "--is-shard" flag (exact match)
  if (process.argv.includes("--is-shard")) {
    return true;
  }

  // Search for any argument containing "is-shard" (case insensitive)
  for (const arg of process.argv) {
    if (arg.toLowerCase().includes("is-shard")) {
      return true;
    }
  }

  // Check if this process was spawned by a sharding manager
  // This might be unreliable but adds an extra check
  return Boolean(typeof process.send === "function");
}

/**
 * Get the shard ID for this process
 * @returns number representing the shard ID or 0 if not determinable
 */
export function getShardId(): number {
  if (!isShard()) {
    return -1;
  }

  // Try to get the shard ID from command line arguments
  for (const arg of process.argv) {
    const match = /--shardId=(\d+)/.exec(arg);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // Fallback to environment variable if available
  if (process.env.SHARD_ID) {
    return parseInt(process.env.SHARD_ID, 10);
  }

  return 0; // Default to 0 if we can't determine the shard ID
}

/**
 * Helper to determine if this process is the main process
 */
export const isMainProcess = (): boolean => {
  return processState.role === ProcessRole.MAIN;
};

/**
 * Set up minimal signal handling for the current process role
 * This only sets up basic handlers that won't conflict with ShutdownManager
 */
export function setupMinimalSignalHandlers(): void {
  // For shards, just log when signals are received
  if (isShard()) {
    const shardId = getShardId();

    // Only log signals, don't take action
    process.on("SIGINT", () => {
      console.log(`[SHARD ${shardId}] Received SIGINT, waiting for parent process instructions`);
    });

    process.on("SIGTERM", () => {
      console.log(`[SHARD ${shardId}] Received SIGTERM, waiting for parent process instructions`);
    });

    // For main process, ShutdownManager will handle signals
  }
}
