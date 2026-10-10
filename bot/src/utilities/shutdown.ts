import { Client } from "discord.js"
import { SERVICE_KEYS, serviceRegistry } from "../services"
import { ErrorSeverity, handleApiError } from "./errorSystem"
import { EventManager } from "./eventManager"
import { logger, safeLog } from "./logger"
import { getShardId, isShard } from "./processState"
import { ProcessType, removeProcessLock } from "./startup"

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

// Define default timeout values that can be overridden in config
const DEFAULT_TIMEOUTS = {
  SHUTDOWN_FORCE_EXIT: 15000, // 15 seconds before force exit
  SHUTDOWN_SAFETY: 30000, // 30 seconds max shutdown time
  TASK_DEFAULT: 5000, // 5 seconds default per task
  SIGNAL_COOLDOWN: 1000, // 1 second between signals
  SHUTDOWN_COOLDOWN: 5000, // Minimum time between shutdown requests (5 seconds)
  MIN_EXIT_DELAY: 2000, // Minimum exit delay after a previous exit attempt
  FINAL_EXIT_DELAY: 1000, // Delay before final exit to ensure logs are written
};

// Simply get the value from DEFAULT_TIMEOUTS without checking config
// Fix for security/detect-object-injection warning using a safer switch pattern
function getTimeoutValue(key: keyof typeof DEFAULT_TIMEOUTS): number {
  // Using a safer pattern to avoid object injection
  switch (key) {
    case "SHUTDOWN_FORCE_EXIT":
      return DEFAULT_TIMEOUTS.SHUTDOWN_FORCE_EXIT;
    case "SHUTDOWN_SAFETY":
      return DEFAULT_TIMEOUTS.SHUTDOWN_SAFETY;
    case "TASK_DEFAULT":
      return DEFAULT_TIMEOUTS.TASK_DEFAULT;
    case "SIGNAL_COOLDOWN":
      return DEFAULT_TIMEOUTS.SIGNAL_COOLDOWN;
    case "SHUTDOWN_COOLDOWN":
      return DEFAULT_TIMEOUTS.SHUTDOWN_COOLDOWN;
    case "MIN_EXIT_DELAY":
      return DEFAULT_TIMEOUTS.MIN_EXIT_DELAY;
    case "FINAL_EXIT_DELAY":
      return DEFAULT_TIMEOUTS.FINAL_EXIT_DELAY;
    default:
      // Default fallback (should never happen due to TypeScript type checking)
      return 5000;
  }
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
let consoleSigintDisplayed = false; // Track console output to avoid duplication
let lastSignalTime = 0; // Track time between signals to prevent duplicates
// Use the default values directly
const SHUTDOWN_COOLDOWN = DEFAULT_TIMEOUTS.SHUTDOWN_COOLDOWN;
const MIN_EXIT_DELAY = DEFAULT_TIMEOUTS.MIN_EXIT_DELAY;

// Static variables for exit process
let clearedTimers = false;
let exitTimeoutSet = false;
let lastLoggedReason = "";
let exitTimeoutId: NodeJS.Timeout | null = null; // Track the timeout ID
const pendingExitPromise = new Promise<never>(() => undefined);

// Module-level arrays to hold registered timers
const globalActiveIntervals: NodeJS.Timeout[] = [];
const globalActiveTimeouts: NodeJS.Timeout[] = [];

// Module-level singleton instance for the shutdown manager (declaration moved up)
let shutdownManagerInstance: ShutdownManager | null = null;

/**
 * Fallback exit function when shutdownManager isn't available
 * This provides a consistent way to exit even during initialization
 *
 * @param exitCode The exit code to use when terminating the process
 * @param reason The reason for shutdown
 * @param delayMs Optional delay before exiting (default 200ms)
 */
export function exitProcess(exitCode: number, reason: string, delayMs = 200): Promise<never> {
  try {
    logger.debug("Exit process called", "EXIT");

    // Block duplicate exit attempts
    if (exitTimeoutSet && exitTimeoutId) {
      return pendingExitPromise;
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

      // Use global collections for tracking timers outside the shutdown manager
      if (globalActiveIntervals.length > 0) {
        logger.debug(
          `Clearing ${globalActiveIntervals.length} global intervals before exit`,
          logContext
        );
        globalActiveIntervals.forEach(clearInterval);
      }

      if (globalActiveTimeouts.length > 0) {
        logger.debug(
          `Clearing ${globalActiveTimeouts.length} global timeouts before exit`,
          logContext
        );
        globalActiveTimeouts.forEach(clearTimeout);
      }

      // Get timers from shutdown manager if available
      try {
        if (shutdownManagerInstance) {
          const managerIntervals = shutdownManagerInstance.getRegisteredIntervals();
          const managerTimeouts = shutdownManagerInstance.getRegisteredTimeouts();

          if (managerIntervals.length > 0) {
            logger.debug(
              `Clearing ${managerIntervals.length} manager intervals before exit`,
              logContext
            );
            managerIntervals.forEach(clearInterval);
          }

          if (managerTimeouts.length > 0) {
            logger.debug(
              `Clearing ${managerTimeouts.length} manager timeouts before exit`,
              logContext
            );
            managerTimeouts.forEach(clearTimeout);
          }
        }
      } catch (err) {
        logger.debug(`Failed to clear shutdown manager timers: ${err}`, logContext);
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
            logger.debug(`Removing shard ${shardIdNum} process lock due to shutdown`, logContext);
            removeProcessLock(ProcessType.SHARD, shardIdNum);
          } else {
            removeProcessLock(ProcessType.MAIN);
            logger.debug("Removed main process lock due to shutdown", logContext);
          }
        } catch (err) {
          logger.error(`Error during process lock cleanup: ${err}`);
        }

        // Finally exit the process
        logger.debug(`Process exit with code ${exitCode} - cleaning up`, logContext);
        process.exitCode = exitCode;

        // skipcq: JS-0263
        process.exit(exitCode);
      }, finalDelayMs);
    }

    // Set a hard timeout in case our nice exit doesn't work
    return new Promise<never>(() => {
      setTimeout(() => {
        process.exitCode = exitCode;
        process.exit(exitCode);
      }, finalDelayMs + 1000);
    });
  } catch (e) {
    console.error("Critical error during exit:", e);
    process.kill(process.pid, "SIGKILL");
    throw new Error("Process termination failed", { cause: e });
  }
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
  getRegisteredIntervals(): NodeJS.Timeout[];
  getRegisteredTimeouts(): NodeJS.Timeout[];
  enterMaintenanceMode(): void;
  exitMaintenanceMode(): void;
  getUptime(): number;
  shutdown(exitCode?: number, reason?: string): Promise<never>;
}

/**
 * Create a shutdown manager instance
 * @param client Discord client instance
 * @returns ShutdownManager instance
 */
export function createShutdownManager(
  client: Client,
  onShutdownSignal?: (signal: string) => void | Promise<void>
): ShutdownManager {
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

  /**
   * Helper function to get all active interval IDs from our registry
   * Keeping this function inside the manager avoids "unused" warning
   */
  function getManagerIntervals(): NodeJS.Timeout[] {
    safeLog("debug", `Returning ${activeIntervals.length} tracked intervals`, "SHUTDOWN");
    return [...activeIntervals];
  }

  /**
   * Helper function to get all active timeout IDs from our registry
   * Keeping this function inside the manager avoids "unused" warning
   */
  function getManagerTimeouts(): NodeJS.Timeout[] {
    safeLog("debug", `Returning ${activeTimeouts.length} tracked timeouts`, "SHUTDOWN");
    return [...activeTimeouts];
  }

  // Function to set up process signal handlers
  function setupProcessHandlers(): void {
    if (handlerInitialized) {
      safeLog("trace", "Signal handlers already initialized, skipping", "SHUTDOWN");
      return; // Don't set up handlers multiple times
    }

    // Ensure we don't exceed the max listeners warning threshold
    process.setMaxListeners(20);
    handlerInitialized = true;

    // Use a shared handler for both SIGINT and SIGTERM to reduce code duplication
    const signalHandler = (signal: string) => {
      global.isShuttingDown = true;

      // Deduplicate signals that come too quickly
      const now = Date.now();
      if (now - lastSignalTime < getTimeoutValue("SIGNAL_COOLDOWN")) {
        return; // Ignore rapid duplicate signals
      }
      lastSignalTime = now;

      // Only log once in console from main process
      if (!consoleSigintDisplayed && !isShard()) {
        consoleSigintDisplayed = true;
        console.log(`\n\nReceived ${signal} - Shutting down Thread-Watcher...`);
      }

      // Only log warning once per process
      if (signalReceivedTime === 0) {
        signalReceivedTime = now;
        logger.warn(`Received ${signal} signal`);
      }

      // Special handling for shards - let parent process coordinate shutdown
      if (isShard()) {
        const shardId = process.env.SHARD_ID || "0";
        logger.debug(
          `Shard ${shardId} received ${signal} - waiting for parent coordination`,
          "SHUTDOWN"
        );
        return;
      }

      // For main process, initiate shutdown if not already in progress
      if (shutdownInProgress) return;

      if (onShutdownSignal) {
        void Promise.resolve(onShutdownSignal(signal)).catch((error: unknown) => {
          safeLog("error", `Shutdown signal handler failed: ${String(error)}`, "SHUTDOWN");
          exitProcess(1, `Shutdown signal handler failed: ${String(error)}`);
        });
        return;
      }

      shutdownInProgress = true;
      void shutdown(0, `${signal} received`);
    };

    // Register shared handler for both signals
    process.on("SIGINT", () => signalHandler("SIGINT"));
    process.on("SIGTERM", () => signalHandler("SIGTERM"));

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      // Skip exit errors that are part of normal shutdown
      if (error.name === "ProcessExit" && error.message.includes("Process exit with code")) {
        return;
      }

      if (shutdownInProgress) {
        logger.debug(`Additional uncaught exception during shutdown: ${error.message}`, "SHUTDOWN");
        return;
      }

      shutdownInProgress = true;
      logger.error(`Uncaught exception: ${error.message}`, "SHUTDOWN");
      if (error.stack) {
        logger.debug(`Stack trace: ${error.stack}`, "SHUTDOWN");
      }

      shutdown(1, "Uncaught exception");
    });

    // Keep the unhandled rejection handler as is
    process.on("unhandledRejection", (reason) => {
      const reasonStr = reason instanceof Error ? reason.message : String(reason);
      logger.error(`Unhandled promise rejection: ${reasonStr}`, "SHUTDOWN");
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
    const SHUTDOWN_COOLDOWN = getTimeoutValue("SHUTDOWN_COOLDOWN");
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

    // Add safety timeout with configurable duration
    const SHUTDOWN_SAFETY = getTimeoutValue("SHUTDOWN_SAFETY");
    shutdownTimeout = setTimeout(() => {
      safeLog("warn", `Shutdown taking too long (${SHUTDOWN_SAFETY}ms) - forcing exit`, "SHUTDOWN");
      exitProcess(1, "Shutdown timeout exceeded");
    }, SHUTDOWN_SAFETY);

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
                return null;
              }
            })
          );
        }
      }

      // Handle process lock cleanup - simplified
      const shardId = isShard() ? getShardId() : undefined;

      if (isShard() && shardId !== undefined) {
        removeProcessLock(ProcessType.SHARD, shardId);
        safeLog("trace", `Removed process lock for Shard ${shardId}`, "SHUTDOWN");
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

      // Use configurable final exit delay
      const FINAL_EXIT_DELAY = getTimeoutValue("FINAL_EXIT_DELAY");
      return exitProcess(
        exitCode,
        `${reason} (completed in ${shutdownDuration}ms)`,
        FINAL_EXIT_DELAY
      );
    } catch (error) {
      // First log the error
      safeLog("error", `Unhandled error during shutdown: ${String(error)}`, "SHUTDOWN");

      // Try to use handleApiError if available
      try {
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
        );
      } catch {
        // Fallback error handling - we already logged above
      }

      // Clear safety timeout
      if (shutdownTimeout) {
        clearTimeout(shutdownTimeout);
        shutdownTimeout = null;
      }

      // Reset flag before exit so future restarts can work
      shutdownInProgress = false;

      // Use configurable final exit delay
      const FINAL_EXIT_DELAY = getTimeoutValue("FINAL_EXIT_DELAY");
      return exitProcess(1, `Error during shutdown: ${String(error)}`, FINAL_EXIT_DELAY);
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

    // Register cleanup task to run during shutdown - with improved validation
    registerCleanupTask(task: () => Promise<void>, options = {}): void {
      // Validate the task is actually a function
      if (typeof task !== "function") {
        safeLog(
          "error",
          "Invalid task provided to registerCleanupTask - must be a function",
          "SHUTDOWN"
        );
        return;
      }

      // Extract and validate options with proper defaults
      const priority =
        options.priority !== undefined && Object.values(ShutdownPriority).includes(options.priority)
          ? options.priority
          : ShutdownPriority.NORMAL;

      const name =
        typeof options.name === "string" && options.name.trim() !== ""
          ? options.name.trim()
          : `Task-${cleanupTasks.length + 1}`;

      const timeout =
        typeof options.timeout === "number" && options.timeout > 0
          ? options.timeout
          : getTimeoutValue("TASK_DEFAULT");

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
      if (intervalId) {
        activeIntervals.push(intervalId);
        // Also add to global registry for emergency cleanup
        if (!globalActiveIntervals.includes(intervalId)) {
          globalActiveIntervals.push(intervalId);
        }
        safeLog("trace", "Registered interval for shutdown cleanup", "SHUTDOWN");
      }
      return intervalId;
    },

    // Register a timeout to be cleared on shutdown
    registerTimeout(timeoutId: NodeJS.Timeout): NodeJS.Timeout {
      if (timeoutId) {
        activeTimeouts.push(timeoutId);
        // Also add to global registry for emergency cleanup
        if (!globalActiveTimeouts.includes(timeoutId)) {
          globalActiveTimeouts.push(timeoutId);
        }
        safeLog("trace", "Registered timeout for shutdown cleanup", "SHUTDOWN");
      }
      return timeoutId;
    },

    // Method to expose registered intervals
    getRegisteredIntervals(): NodeJS.Timeout[] {
      return getManagerIntervals();
    },

    // Method to expose registered timeouts
    getRegisteredTimeouts(): NodeJS.Timeout[] {
      return getManagerTimeouts();
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
 * Get the shutdown manager instance
 * Creates one if it doesn't exist
 */
export function getShutdownManager(client?: Client): ShutdownManager {
  if (shutdownManagerInstance) {
    return shutdownManagerInstance;
  }

  let clientToUse = client;

  if (!clientToUse) {
    // Try to get client from service registry
    try {
      if (serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
        clientToUse = serviceRegistry.getSync(SERVICE_KEYS.CLIENT);
      }
    } catch (err) {
      safeLog("debug", `Error getting client from registry: ${err}`, "SHUTDOWN");
    }

    // If still no client, create minimal one
    if (!clientToUse) {
      clientToUse = new Client({ intents: [] });
      safeLog("debug", "Created minimal client for shutdown manager", "SHUTDOWN");
    }
  }

  const manager = createShutdownManager(clientToUse);

  // Register in service registry if available
  try {
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
      serviceRegistry.register(SERVICE_KEYS.SHUTDOWN_MANAGER, manager);
      safeLog("debug", "Registered shutdown manager in service registry", "SHUTDOWN");
    }
  } catch (err) {
    safeLog("debug", `Failed to register shutdown manager: ${err}`, "SHUTDOWN");
  }

  return manager;
}

/**
 * Initialize shutdown handlers for the application (for shard processes)
 */
export function initializeShutdownHandlers(isShardProcess = false): void {
  // Ensure we don't exceed the max listeners warning threshold
  process.setMaxListeners(20);

  // Add specific handling for shards
  if (isShardProcess) {
    // Register shutdown handler through EventManager instead of direct messageRouter use
    EventManager.addProcessHandler(
      "message",
      "shutdown-handler",
      (message) => {
        // Skip messages that aren't objects
        if (!message || typeof message !== "object") {
          return;
        }

        // Type guard with property checking
        const msgObj = message as Record<string, unknown>;

        // Only process SHUTDOWN messages
        if (!("type" in msgObj) || msgObj.type !== "SHUTDOWN") {
          return;
        }

        // Safely extract exit code with validation
        let exitCode = 0;
        if (
          "code" in msgObj &&
          typeof msgObj.code === "number" &&
          Number.isInteger(msgObj.code) &&
          msgObj.code >= 0 &&
          msgObj.code <= 255
        ) {
          exitCode = msgObj.code as number;
        }

        // Safely extract reason with validation
        let reason = "Requested by parent";
        if ("reason" in msgObj && typeof msgObj.reason === "string") {
          // Sanitize the reason string to prevent injection
          reason = String(msgObj.reason).substring(0, 200).trim();
        }

        // Get shard ID for better logging
        const shardId = process.env.SHARD_ID || "0";
        safeLog(
          "info",
          `Shard ${shardId} received shutdown command from parent: ${reason}`,
          "SHUTDOWN"
        );

        // Handle the shutdown via the normal exit process
        if (!shutdownInProgress) {
          shutdownInProgress = true;
          exitProcess(exitCode, reason);
        }
      },
      {
        filter: (message) => {
          if (typeof message !== "object" || message === null) return false;
          const msg = message as Record<string, unknown>;
          return "type" in msg && msg.type === "SHUTDOWN";
        },
        priority: 100, // Very high priority
      }
    );

    safeLog("trace", "Registered shutdown message handler", "SHUTDOWN");

    // Clean up handler on exit
    process.once("exit", () => {
      EventManager.removeProcessHandler("message", "shutdown-handler");
      safeLog("trace", "Cleaned up shutdown message handler on exit", "SHUTDOWN");
    });
  }
}
