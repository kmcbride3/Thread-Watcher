import { Client } from "discord.js";
import { logger } from "../index";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import { safeLog } from "./logger";
import { getShardId, isShard } from "./processState";
import { ProcessType, removeProcessLock } from "./startup";

/**
 * Priority levels for shutdown tasks
 * Higher priority tasks run first
 */
export enum ShutdownPriority {
  CRITICAL = 3, // First to run: Security concerns, data integrity
  HIGH = 2, // Important cleanup: DB connections, persistent state
  NORMAL = 1, // Standard cleanup: Cache clearing, temp files
  LOW = 0, // Last to run: Metrics reporting, non-critical tasks
}

/**
 * Interface for shutdown tasks
 */
interface ShutdownTask {
  fn: () => Promise<void>;
  priority: ShutdownPriority;
  name: string;
  timeout: number;
}

/**
 * Application state during shutdown
 */
export enum AppState {
  RUNNING = "running",
  SHUTTING_DOWN = "shutting_down",
  MAINTENANCE = "maintenance",
}

/**
 * Safely get priority name from enum value
 * @param priority The priority enum value
 * @returns The string name of the priority
 */
function safeGetPriorityName(priority: ShutdownPriority): string {
  // Use a switch statement instead of dynamic property access to avoid object injection
  switch (priority) {
    case ShutdownPriority.CRITICAL:
      return "CRITICAL";
    case ShutdownPriority.HIGH:
      return "HIGH";
    case ShutdownPriority.NORMAL:
      return "NORMAL";
    case ShutdownPriority.LOW:
      return "LOW";
    default:
      return "UNKNOWN";
  }
}

/**
 * Module-level shutdown tracking variables to prevent restart loops
 */
let shutdownInProgress = false;
let lastShutdownTime = 0;
let handlerInitialized = false;
let signalReceivedTime = 0;
const SHUTDOWN_COOLDOWN = 5000; // Minimum time between shutdown requests (5 seconds)
const MIN_EXIT_DELAY = 2000; // Minimum exit delay after a previous exit attempt

// Static variables for exit process
let clearedTimers = false;
let exitTimeoutSet = false;
let lastLoggedReason = "";
let exitTimeoutId: NodeJS.Timeout | null = null; // Track the timeout ID

/**
 * Fallback exit function when shutdownManager isn't available
 * This provides a consistent way to exit even during initialization
 *
 * @param exitCode The exit code to use when terminating the process
 * @param reason The reason for shutdown
 * @param delayMs Optional delay before exiting (default 200ms)
 */
export function exitProcess(
  exitCode = 0,
  reason = "Requested shutdown",
  delayMs = 200
): Promise<never> {
  try {
    // If we already have a pending exit timeout, don't start another one
    if (exitTimeoutSet && exitTimeoutId) {
      logger.debug(`Exit already in progress, ignoring duplicate exitProcess call`, "EXIT");
      return new Promise((resolve) => {
        // This promise never resolves since the existing timeout will exit the process
        setTimeout(() => resolve(process.exit(exitCode)), 30000);
      });
    }

    // Immediately flag that shutdown is in progress to block duplicate calls
    global.isShuttingDown = true;

    // Block duplicate exit attempts happening too close together
    const now = Date.now();
    let finalDelayMs = delayMs;

    // Use a specific debug tag based on process role
    const processType = isShard() ? "SHARD" : "MAIN";
    const shardId = process.env.SHARD_ID || "0";
    const logContext = isShard()
      ? `${processType.toUpperCase()} ${shardId}`
      : processType.toUpperCase();

    if (now - lastShutdownTime < SHUTDOWN_COOLDOWN) {
      logger.warn(`Frequent exit calls detected (${now - lastShutdownTime}ms apart)`, logContext);
      // Use a much longer delay to break potential loops
      finalDelayMs = Math.max(delayMs, MIN_EXIT_DELAY);

      // If we're in a very tight loop (under 100ms), use an even longer delay
      if (now - lastShutdownTime < 100) {
        logger.warn("Detected very tight shutdown loop, using extended delay", logContext);
        finalDelayMs = Math.max(delayMs, MIN_EXIT_DELAY * 2);
      }
    }
    lastShutdownTime = now;

    // For log deduplication
    const shortReason = reason.split(" ").slice(0, 3).join(" ");
    if (lastLoggedReason !== shortReason) {
      // Only log if the reason has changed to reduce duplicate messages
      if (!reason.includes("completed in") && !reason.includes("(completed")) {
        logger.info(`Process ${process.pid} exiting with code ${exitCode}: ${reason}`, logContext);
      }
      lastLoggedReason = shortReason;
    }

    // Clear intervals and timeouts just once
    if (!clearedTimers) {
      clearedTimers = true;

      const intervalIds = getActiveIntervalIds();
      if (intervalIds.length > 0) {
        logger.debug(`Clearing ${intervalIds.length} active intervals before exit`, logContext);
        intervalIds.forEach((id) => clearInterval(id));
      }

      const timerIds = getActiveTimeoutIds();
      if (timerIds.length > 0) {
        logger.debug(`Clearing ${timerIds.length} active timeouts before exit`, logContext);
        timerIds.forEach((id) => clearTimeout(id));
      }
    }

    // Use a single exit timeout to prevent multiple exit attempts
    if (!exitTimeoutSet) {
      exitTimeoutSet = true;

      // Log the actual exit call for debugging
      logger.debug(`Executing final process exit (code: ${exitCode})`, logContext);

      exitTimeoutId = setTimeout(() => {
        logger.debug(`Process exit with code ${exitCode}`, logContext);

        try {
          // Clean up process locks on exit
          if (isShard()) {
            const shardIdNum = parseInt(shardId, 10);
            removeProcessLock(ProcessType.SHARD, shardIdNum);
            logger.debug(`Removed shard ${shardId} process lock due to shutdown`, logContext);
          } else {
            removeProcessLock(ProcessType.MAIN);
            logger.debug(`Removed main process lock due to shutdown`, logContext);
          }
        } catch {
          // Silently ignore errors during cleanup
        }

        // Finally exit the process
        logger.debug(`Process exit with code ${exitCode} - cleaning up`, logContext);
        process.exit(exitCode);
      }, finalDelayMs);
    }

    // This promise never resolves, as process.exit will terminate execution
    return new Promise((resolve) => {
      setTimeout(() => resolve(process.exit(exitCode)), finalDelayMs + 1000);
    });
  } catch (e) {
    console.error("Critical error during exit:", e);
    process.kill(process.pid, "SIGKILL");
    throw new Error("Process termination failed");
  }
}

/**
 * Helper function to get all active interval IDs using Node.js internals
 * This helps ensure we don't leave any dangling intervals during shutdown
 */
function getActiveIntervalIds(): NodeJS.Timeout[] {
  const ids: NodeJS.Timeout[] = [];

  // Use a hack to access Node's internal timer handles
  try {
    // This is a bit hacky but works to access Node's internal timer list

    const timers = process
      // @ts-expect-error - accessing Node.js internals
      ._getActiveHandles()
      .filter(
        (handler: unknown) =>
          handler &&
          typeof handler === "object" &&
          "hasRef" in handler &&
          typeof handler.hasRef === "function"
      );

    // Add all timer/interval handles to our list
    for (const timer of timers) {
      if ("_repeat" in timer && timer._repeat) {
        // Intervals have a _repeat property
        ids.push(timer as unknown as NodeJS.Timeout);
      }
    }
  } catch (err) {
    safeLog("debug", `Failed to access internal timer handles: ${err}`, "SHUTDOWN");
  }

  return ids;
}

/**
 * Helper function to get all active timeout IDs using Node.js internals
 */
function getActiveTimeoutIds(): NodeJS.Timeout[] {
  const ids: NodeJS.Timeout[] = [];

  try {
    const timers = process
      // @ts-expect-error - accessing Node.js internals
      ._getActiveHandles()
      .filter(
        (handler: unknown) =>
          handler &&
          typeof handler === "object" &&
          "hasRef" in handler &&
          typeof handler.hasRef === "function"
      );

    for (const timer of timers) {
      if (!("_repeat" in timer) || !timer._repeat) {
        // Regular timeouts don't have _repeat
        ids.push(timer as unknown as NodeJS.Timeout);
      }
    }
  } catch (err) {
    safeLog("debug", `Failed to access internal timeout handles: ${err}`, "SHUTDOWN");
  }

  return ids;
}

/**
 * Shutdown Manager interface with enhanced functionality
 */
export interface ShutdownManager {
  readonly appState: AppState;
  registerCleanupTask(
    task: () => Promise<void>,
    options?: {
      priority?: ShutdownPriority;
      name?: string;
      timeout?: number;
    }
  ): void;
  registerInterval(intervalId: NodeJS.Timeout): NodeJS.Timeout;
  registerTimeout(timeoutId: NodeJS.Timeout): NodeJS.Timeout;
  enterMaintenanceMode(): void;
  exitMaintenanceMode(): void;
  getUptime(): number;
  shutdown(exitCode?: number, reason?: string): Promise<never>;
}

// Module-level singleton instance for the shutdown manager
let shutdownManagerInstance: ShutdownManager | null = null;

/**
 * Create a shutdown manager instance
 * @param client Discord client instance
 * @returns ShutdownManager instance
 */
export function createShutdownManager(client: Client): ShutdownManager {
  if (shutdownManagerInstance) {
    safeLog("trace", "Using existing shutdown manager instance", "SHUTDOWN");
    return shutdownManagerInstance;
  }

  // Track registered tasks and timers
  const cleanupTasks: ShutdownTask[] = [];
  const activeIntervals: NodeJS.Timeout[] = [];
  const activeTimeouts: NodeJS.Timeout[] = [];

  // Track task names to prevent duplicates
  const registeredTaskNames = new Set<string>();

  // State tracking
  const startTime = Date.now();
  let currentAppState = AppState.RUNNING;
  let shutdownTimeout: NodeJS.Timeout | null = null;

  // Function to set up process signal handlers
  function setupProcessHandlers(): void {
    if (handlerInitialized) {
      safeLog("trace", "Signal handlers already initialized, skipping", "SHUTDOWN");
      return; // Don't set up handlers multiple times
    }

    handlerInitialized = true;
    safeLog("trace", "Initializing signal handlers", "SHUTDOWN");

    // Track if we've already started shutdown to avoid duplicates
    let handlerShutdownInitiated = false;

    // For signal deduplication
    let lastSignalTime = 0;
    const SIGNAL_COOLDOWN = 1000; // 1 second between signals

    // Handle SIGINT (Ctrl+C)
    process.on("SIGINT", () => {
      global.isShuttingDown = true;

      // Deduplicate signals that come too quickly
      const now = Date.now();
      if (now - lastSignalTime < SIGNAL_COOLDOWN) {
        return; // Ignore rapid duplicate signals
      }
      lastSignalTime = now;

      // To avoid the double message, only log once
      if (signalReceivedTime === 0) {
        signalReceivedTime = now;
        console.log("\n\nReceived SIGINT (Ctrl+C) - Shutting down Thread-Watcher...");
      }

      // Special handling for shards
      if (isShard()) {
        const shardId = process.env.SHARD_ID || "0";
        safeLog(
          "trace",
          `Shard ${shardId} received SIGINT - waiting for parent coordination`,
          "SHUTDOWN"
        );

        // Shards should wait for the main process to tell them to shut down
        // This prevents race conditions in cleanup
        safeLog(
          "trace",
          `Received SIGINT directly, waiting for main process coordination`,
          `SHARD ${shardId}`
        );
        safeLog("warn", "Received SIGINT signal");

        // Only if we're a shard, don't proceed with our own shutdown sequence
        return;
      }

      if (handlerShutdownInitiated || shutdownInProgress) {
        return; // Already shutting down, prevent duplicate calls
      }

      handlerShutdownInitiated = true;
      shutdownInProgress = true;

      safeLog("warn", "Received SIGINT signal");

      // Pass SIGINT message to the shutdown handler
      shutdown(0, "SIGINT received");
    });

    // Handle SIGTERM (system termination request)
    process.on("SIGTERM", () => {
      global.isShuttingDown = true;

      // Deduplicate signals that come too quickly
      const now = Date.now();
      if (now - lastSignalTime < SIGNAL_COOLDOWN) {
        return; // Ignore rapid duplicate signals
      }
      lastSignalTime = now;

      // To avoid the double message, only log once
      if (signalReceivedTime === 0) {
        signalReceivedTime = now;
        console.log("\n\nReceived SIGTERM - Shutting down Thread-Watcher...");
      }

      // Special handling for shards
      if (isShard()) {
        const shardId = process.env.SHARD_ID || "0";
        safeLog(
          "trace",
          `Shard ${shardId} received SIGTERM - waiting for parent to coordinate shutdown`,
          "SHUTDOWN"
        );

        // Shards should wait for the main process
        safeLog(
          "trace",
          `Received SIGTERM directly, waiting for main process coordination`,
          `SHARD ${shardId}`
        );
        safeLog("warn", "Received SIGTERM signal");

        // Only if we're a shard, don't proceed with our own shutdown sequence
        return;
      }

      safeLog("warn", "Received SIGTERM signal");

      // Continue with shutdown only in the main process
      if (handlerShutdownInitiated || shutdownInProgress) {
        return; // Already shutting down
      }

      handlerShutdownInitiated = true;
      shutdownInProgress = true;
      shutdown(0, "SIGTERM received");
    });

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      if (handlerShutdownInitiated || shutdownInProgress) {
        safeLog(
          "error",
          `Additional uncaught exception during shutdown: ${error.message}`,
          "SHUTDOWN"
        );
        return;
      }

      handlerShutdownInitiated = true;
      safeLog("error", `Uncaught exception: ${error.message}`, "SHUTDOWN");
      if (error.stack) {
        safeLog("error", `Stack trace: ${error.stack}`, "SHUTDOWN");
      }

      shutdown(1, "Uncaught exception");
    });

    // Just log unhandled rejections without shutting down
    process.on("unhandledRejection", (reason) => {
      const reasonStr = reason instanceof Error ? reason.message : String(reason);
      safeLog("error", `Unhandled promise rejection: ${reasonStr}`, "SHUTDOWN");
    });
  }

  // Create the core shutdown function
  async function shutdown(exitCode = 0, reason = "Requested shutdown"): Promise<never> {
    // Prevent multiple shutdowns or too-frequent shutdowns
    if (shutdownInProgress) {
      safeLog("info", "Shutdown already in progress, ignoring duplicate request", "SHUTDOWN");
      return exitProcess(exitCode, "Duplicate shutdown request - already in progress");
    }

    const now = Date.now();
    if (now - lastShutdownTime < SHUTDOWN_COOLDOWN) {
      safeLog(
        "warn",
        `Shutdown requested too soon after previous attempt (${now - lastShutdownTime}ms). Waiting...`,
        "SHUTDOWN"
      );
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_COOLDOWN));
    }

    // Set flags and track shutdown start
    shutdownInProgress = true;
    lastShutdownTime = Date.now();
    global.isShuttingDown = true;
    currentAppState = AppState.SHUTTING_DOWN;

    // Store start time for performance tracking
    const shutdownStartTime = Date.now();
    safeLog("info", `Initiating shutdown: ${reason}`, "SHUTDOWN");

    // Use a single timeout reference
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
    }

    // Add safety timeout
    shutdownTimeout = setTimeout(() => {
      safeLog("warn", "Shutdown taking too long - forcing exit", "SHUTDOWN");
      exitProcess(1, "Shutdown timeout exceeded");
    }, 30000); // 30 second max shutdown time

    try {
      // Disconnect Discord client
      if (client?.isReady()) {
        safeLog("debug", "Destroying Discord client connection...", "SHUTDOWN");
        try {
          await client.destroy();
          safeLog("trace", "Discord client destroyed successfully", "SHUTDOWN");
        } catch (error) {
          safeLog("error", `Error destroying Discord client: ${String(error)}`, "SHUTDOWN");
        }
      }

      // Clear all active intervals and timeouts
      if (activeIntervals.length > 0) {
        safeLog("trace", `Clearing ${activeIntervals.length} tracked intervals`, "SHUTDOWN");
        activeIntervals.forEach(clearInterval);
      }

      if (activeTimeouts.length > 0) {
        safeLog("trace", `Clearing ${activeTimeouts.length} tracked timeouts`, "SHUTDOWN");
        activeTimeouts.forEach(clearTimeout);
      }

      // Run cleanup tasks in priority order (highest first)
      const sortedTasks = [...cleanupTasks].sort((a, b) => b.priority - a.priority);

      // Group tasks by priority for better logging
      const tasksByPriority = new Map<ShutdownPriority, ShutdownTask[]>();
      for (const task of sortedTasks) {
        if (!tasksByPriority.has(task.priority)) {
          tasksByPriority.set(task.priority, []);
        }
        const tasks = tasksByPriority.get(task.priority);
        if (tasks) {
          tasks.push(task);
        }
      }

      // Process each priority group in order
      for (const priority of [
        ShutdownPriority.CRITICAL,
        ShutdownPriority.HIGH,
        ShutdownPriority.NORMAL,
        ShutdownPriority.LOW,
      ]) {
        const tasksInGroup = tasksByPriority.get(priority) || [];

        if (tasksInGroup.length > 0) {
          // Use the safe helper function instead of direct enum access
          const priorityName = safeGetPriorityName(priority);
          safeLog(
            "trace",
            `Running ${priorityName} priority tasks (${tasksInGroup.length})`,
            "SHUTDOWN"
          );

          // Run all tasks in this priority group
          await Promise.allSettled(
            tasksInGroup.map(async (task) => {
              try {
                safeLog("debug", `Starting task: ${task.name}`, "SHUTDOWN");

                // Race the task against its timeout
                const result = await Promise.race([
                  task.fn(),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () =>
                        reject(new Error(`Task ${task.name} timed out after ${task.timeout}ms`)),
                      task.timeout
                    )
                  ),
                ]);

                safeLog("debug", `Completed task: ${task.name}`, "SHUTDOWN");
                return result;
              } catch (error) {
                safeLog("error", `Error in task ${task.name}: ${String(error)}`, "SHUTDOWN");
              }
            })
          );
        }
      }

      // Handle process lock cleanup - simplified
      const shardId = isShard() ? getShardId() : undefined;

      if (isShard() && shardId !== undefined) {
        removeProcessLock(ProcessType.SHARD, shardId);
        safeLog("trace", `Removed process lock for shard ${shardId}`, "SHUTDOWN");
      } else {
        removeProcessLock(ProcessType.MAIN);
        safeLog("trace", "Removed process lock for main process", "SHUTDOWN");
      }

      // Clear safety timeout
      if (shutdownTimeout) {
        clearTimeout(shutdownTimeout);
        shutdownTimeout = null;
      }

      // Calculate and log shutdown duration
      const shutdownDuration = Date.now() - shutdownStartTime;
      safeLog("info", `Shutdown completed in ${shutdownDuration}ms`, "SHUTDOWN");

      // Reset flag - even though we're exiting, this helps in case something prevents the exit
      shutdownInProgress = false;

      // Use a slightly longer delay for final exit to ensure logs are written
      return exitProcess(exitCode, `${reason} (completed in ${shutdownDuration}ms)`, 1000);
    } catch (error) {
      // Use handleApiError for better error handling and reporting
      await handleApiError(
        "Critical error during shutdown",
        async () => {
          throw error; // Rethrow to trigger the error handler
        },
        {
          retries: 0,
          context: "Shutdown Process",
          reportAtSeverity: ErrorSeverity.CRITICAL,
        }
      ).catch(() => {
        // This catch will always run since we're throwing above
        safeLog("error", `Unhandled error during shutdown: ${String(error)}`, "SHUTDOWN");
      });

      // Clear safety timeout
      if (shutdownTimeout) {
        clearTimeout(shutdownTimeout);
        shutdownTimeout = null;
      }

      // Reset flag before exit so future restarts can work
      shutdownInProgress = false;

      return exitProcess(1, `Error during shutdown: ${String(error)}`, 1000);
    }
  }

  // Initialize process handlers
  setupProcessHandlers();

  // Return the shutdown manager object
  const manager: ShutdownManager = {
    // Get current application state
    get appState(): AppState {
      return currentAppState;
    },

    // Register cleanup task to run during shutdown
    registerCleanupTask(task: () => Promise<void>, options = {}): void {
      const {
        priority = ShutdownPriority.NORMAL,
        name = `Task-${cleanupTasks.length + 1}`,
        timeout = 5000, // Default 5 second timeout per task
      } = options;

      // Prevent duplicate task registration
      if (registeredTaskNames.has(name)) {
        safeLog(
          "warn",
          `Shutdown task "${name}" already registered, skipping duplicate`,
          "SHUTDOWN"
        );
        return;
      }

      registeredTaskNames.add(name);
      cleanupTasks.push({
        fn: task,
        priority,
        name,
        timeout,
      });

      // Use the safe helper function here too
      safeLog(
        "trace",
        `Registered shutdown task: ${name} (priority: ${safeGetPriorityName(priority)})`,
        "SHUTDOWN"
      );
    },

    // Register an interval to be cleared on shutdown
    registerInterval(intervalId: NodeJS.Timeout): NodeJS.Timeout {
      activeIntervals.push(intervalId);
      return intervalId;
    },

    // Register a timeout to be cleared on shutdown
    registerTimeout(timeoutId: NodeJS.Timeout): NodeJS.Timeout {
      activeTimeouts.push(timeoutId);
      return timeoutId;
    },

    // Set application in maintenance mode
    enterMaintenanceMode(): void {
      currentAppState = AppState.MAINTENANCE;
      safeLog("info", "Application entered maintenance mode", "SHUTDOWN");
    },

    // Exit maintenance mode
    exitMaintenanceMode(): void {
      currentAppState = AppState.RUNNING;
      safeLog("info", "Application exited maintenance mode", "SHUTDOWN");
    },

    // Get uptime in milliseconds
    getUptime(): number {
      return Date.now() - startTime;
    },

    // Initiate application shutdown
    shutdown,
  };

  // Store and return the instance
  shutdownManagerInstance = manager;
  return manager;
}

/**
 * Initialize shutdown handlers for the application (for shard processes)
 */
export function initializeShutdownHandlers(isShardProcess = false): void {
  // Add specific handling for shards
  if (isShardProcess) {
    process.on("message", (message: unknown) => {
      // Listen for shutdown commands from the parent process
      if (typeof message === "object" && message !== null) {
        if ("type" in message && message.type === "SHUTDOWN") {
          const exitCode = "code" in message && typeof message.code === "number" ? message.code : 0;
          const reason =
            "reason" in message && typeof message.reason === "string"
              ? message.reason
              : "Requested by parent";

          // Get the shard ID for better logging
          const shardId = process.env.SHARD_ID || "0";
          safeLog(
            "info",
            `Shard ${shardId} received shutdown command from parent: ${reason}`,
            "SHUTDOWN"
          );

          // Don't directly call process.exit here - use the shutdown handler
          if (!shutdownInProgress) {
            shutdownInProgress = true;
            exitProcess(exitCode, reason);
          }
        }
      }
    });
  }
}
