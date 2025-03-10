import { Client } from "discord.js";
import { logger } from "../index";
import { safeObjectAccess } from "./securityExceptions";

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
 * Safely log a message during shutdown
 * Works even when regular logger isn't available
 */
const safeShutdownLog = (level: string, message: string): void => {
  // Try to use the logger if it's available
  if (
    typeof logger !== "undefined" &&
    logger &&
    typeof logger[level as keyof typeof logger] === "function"
  ) {
    try {
      const logFunction = logger[level as keyof typeof logger] as unknown as (msg: string) => void;
      logFunction(message);
      return;
    } catch {
      // Fall back to console if logger method fails
    }
  }

  const timestamp = new Date().toISOString();
  if (level === "error") {
    console.error(`${timestamp} [ERROR] ${message}`);
  } else if (level === "warn") {
    console.warn(`${timestamp} [WARN] ${message}`);
  } else {
    console.log(`${timestamp} [${level.toUpperCase()}] ${message}`);
  }
};

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
    // Avoid redundant exit messages - only log if not already part of a clean shutdown sequence
    if (!reason.includes("completed in") && !reason.includes("(completed")) {
      safeShutdownLog("info", `Process ${process.pid} exiting with code ${exitCode}: ${reason}`);
    }

    setTimeout(() => {
      try {
        // skipcq: JS-0263
        process.exit(exitCode);
      } catch (e) {
        // This should never happen, but just in case
        console.error("Failed to exit process:", e);
        // Force exit with original exit code
        process.kill(process.pid, "SIGKILL");
      }
    }, delayMs);

    return new Promise((resolve) => {
      // This will never be called because process.exit terminates execution - skipcq: JS-0263
      setTimeout(() => resolve(process.exit(exitCode)), delayMs + 100);
    });
  } catch (e) {
    // Last resort if everything else fails
    console.error("Critical error during exit:", e);
    process.kill(process.pid, "SIGKILL");

    // This will never be reached, just for TypeScript
    throw new Error("Process termination failed");
  }
}

/**
 * Handles graceful shutdown of the application
 */
export class ShutdownManager {
  private client: Client;
  private cleanupFunctions: ShutdownTask[] = [];
  private isShuttingDown = false;
  private shutdownTimeout: NodeJS.Timeout | null = null;
  private _appState: AppState = AppState.RUNNING;
  private startTime: number = Date.now();
  private shutdownStartTime = 0;

  constructor(client: Client) {
    this.client = client;
    this.setupProcessHandlers();
    logger.debug("Shutdown manager initialized");
  }

  /**
   * Current application state
   */
  public get appState(): AppState {
    return this._appState;
  }

  /**
   * Register cleanup functions to be executed on shutdown
   * @param cleanupFn The function to execute during shutdown
   * @param options Additional options for this task
   */
  public registerCleanupTask(
    cleanupFn: () => Promise<void>,
    options: {
      priority?: ShutdownPriority;
      name?: string;
      timeout?: number;
    } = {}
  ): void {
    const {
      priority = ShutdownPriority.NORMAL,
      name = `Task-${this.cleanupFunctions.length + 1}`,
      timeout = 5000, // Default 5 second timeout per task
    } = options;

    this.cleanupFunctions.push({
      fn: cleanupFn,
      priority,
      name,
      timeout,
    });

    // Use safeObjectAccess to safely get priority name from enum
    const priorityNames = Object.keys(ShutdownPriority).filter((key) => isNaN(Number(key)));
    const priorityValue = priority as number;

    // Find the name that matches this priority value
    let priorityName = "UNKNOWN";
    for (const name of priorityNames) {
      const enumValue = safeObjectAccess(ShutdownPriority, name) as number;
      if (enumValue === priorityValue) {
        priorityName = name;
        break;
      }
    }

    logger.debug(`Registered shutdown task: ${name} (priority: ${priorityName})`);
  }

  /**
   * Set application in maintenance mode
   * (Useful before planned restarts or deployments)
   */
  public enterMaintenanceMode(): void {
    this._appState = AppState.MAINTENANCE;
    logger.info("Application entered maintenance mode");
  }

  /**
   * Exit maintenance mode
   */
  public exitMaintenanceMode(): void {
    this._appState = AppState.RUNNING;
    logger.info("Application exited maintenance mode");
  }

  /**
   * Get uptime in milliseconds
   */
  public getUptime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Gracefully shutdown the application
   * @param exitCode The exit code to use (defaults to 0)
   * @param reason The reason for shutdown
   */
  public async shutdown(exitCode = 0, reason = "Requested shutdown"): Promise<never> {
    // If already shutting down, don't start again
    if (this.isShuttingDown) {
      logger.warn("Shutdown already in progress");
      return exitProcess(exitCode, "Shutdown already in progress (duplicate request)");
    }

    this.shutdownStartTime = Date.now();
    this.isShuttingDown = true;
    this._appState = AppState.SHUTTING_DOWN;
    logger.info(`Shutting down: ${reason}`);

    // Set a safety timeout to force exit if cleanup takes too long
    this.shutdownTimeout = setTimeout(() => {
      logger.warn("Shutdown taking too long - forcing exit");
      exitProcess(exitCode, "Shutdown timeout exceeded");
    }, 30000); // 30 second safety timeout

    try {
      // Stop accepting new connections/requests if applicable
      logger.debug("Stopping new connections");

      // Disconnect the Discord client
      if (this.client?.isReady()) {
        logger.debug("Logging out from Discord...");
        try {
          await this.client.destroy();
          logger.debug("Discord client destroyed successfully");
        } catch (error) {
          logger.error(`Error destroying Discord client: ${error}`);
        }
      }

      // Sort tasks by priority (highest first)
      const sortedTasks = [...this.cleanupFunctions].sort((a, b) => b.priority - a.priority);

      // Create a safer map of priority names to values
      const priorityMap = new Map<string, number>();
      Object.entries(ShutdownPriority)
        .filter(([key, _]) => isNaN(Number(key)))
        .forEach(([key, value]) => {
          if (typeof value === "number") {
            priorityMap.set(key, value);
          }
        });

      // Run tasks grouped by priority
      for (const [priorityName, priorityValue] of priorityMap.entries()) {
        const tasksInGroup = sortedTasks.filter((task) => task.priority === priorityValue);

        if (tasksInGroup.length > 0) {
          logger.debug(`Running ${priorityName} priority shutdown tasks...`);

          // Run tasks in this priority group
          await Promise.allSettled(
            tasksInGroup.map(async (task) => {
              try {
                logger.debug(`Starting shutdown task: ${task.name}`);

                // Create a timeout for this specific task
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

                logger.debug(`Completed shutdown task: ${task.name}`);
                return result;
              } catch (error) {
                logger.error(`Error in shutdown task ${task.name}: ${error}`);
                return undefined;
              }
            })
          );
        }
      }

      const shutdownDuration = Date.now() - this.shutdownStartTime;
      logger.done(`Shutdown complete in ${shutdownDuration}ms`);

      // Clear safety timeout since we're exiting normally
      if (this.shutdownTimeout) {
        clearTimeout(this.shutdownTimeout);
        this.shutdownTimeout = null;
      }

      return exitProcess(exitCode, `${reason} (completed in ${shutdownDuration}ms)`);
    } catch (error) {
      logger.error(`Unhandled error during shutdown: ${error}`);

      // Clear safety timeout since we're exiting due to error
      if (this.shutdownTimeout) {
        clearTimeout(this.shutdownTimeout);
        this.shutdownTimeout = null;
      }

      return exitProcess(1, `Error during shutdown: ${error}`);
    }
  }

  /**
   * Set up handlers for process signals and uncaught exceptions
   */
  private setupProcessHandlers(): void {
    // Using a flag to prevent multiple signal handlers from triggering duplicate shutdowns
    let shutdownInitiated = false;

    // Handle termination signals using named handlers
    const handleSigInt = () => {
      if (shutdownInitiated) {
        logger.debug("Ignoring duplicate SIGINT signal - shutdown already in progress");
        return;
      }

      // Skip handling SIGINT in shard processes - let parent coordinate
      if (process.env.IS_SHARD === "true") {
        logger.debug("SIGINT received in shard - waiting for parent to coordinate shutdown");
        return;
      }

      shutdownInitiated = true;
      logger.info("Received SIGINT signal");
      this.shutdown(0, "SIGINT received");
    };

    const handleSigTerm = () => {
      if (shutdownInitiated) {
        logger.debug("Ignoring duplicate SIGTERM signal - shutdown already in progress");
        return;
      }

      // Skip handling SIGTERM in shard processes - let parent coordinate
      if (process.env.IS_SHARD === "true") {
        logger.debug("SIGTERM received in shard - waiting for parent to coordinate shutdown");
        return;
      }

      shutdownInitiated = true;
      logger.info("Received SIGTERM signal");
      this.shutdown(0, "SIGTERM received");
    };

    const handleUncaughtException = (error: Error) => {
      if (shutdownInitiated) {
        logger.error(`Additional uncaught exception during shutdown: ${error.message}`);
        return;
      }
      shutdownInitiated = true;
      logger.error(`Uncaught exception: ${error.message}`);
      if (error.stack) {
        logger.error(`Stack trace: ${error.stack}`);
      }
      this.shutdown(1, "Uncaught exception");
    };

    const handleUnhandledRejection = (reason: unknown) => {
      const reasonStr = reason instanceof Error ? reason.message : String(reason);
      logger.error(`Unhandled promise rejection: ${reasonStr}`);
      // Log but don't automatically shutdown for unhandled rejections
    };

    // Attach handlers
    process.on("SIGINT", handleSigInt);
    process.on("SIGTERM", handleSigTerm);
    process.on("uncaughtException", handleUncaughtException);
    process.on("unhandledRejection", handleUnhandledRejection);

    logger.debug("Signal handlers initialized in shutdown manager");
  }
}

// Export a factory function to create the shutdown manager
export const createShutdownManager = (client: Client): ShutdownManager => {
  return new ShutdownManager(client);
};
