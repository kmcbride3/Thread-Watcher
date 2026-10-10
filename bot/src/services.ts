import { Client, Collection, ShardingManager } from "discord.js";
import { Database } from "./interfaces/database";
import { ConfigFile } from "./utilities/cnf";
import { reportError } from "./utilities/errorReporter";
import type { EventManager } from "./utilities/eventManager";
import { Log76, safeLog } from "./utilities/logger";
import { MessageRouter } from "./utilities/messageRouter";
import { RateLimitManager } from "./utilities/rateLimitManager";
import { ShutdownManager } from "./utilities/shutdown";
import { ThreadManager } from "./utilities/threadManager";
import UserSettings from "./utilities/userSettings";

// Define service keys as string constants for type safety and easier refactoring
export const SERVICE_KEYS = {
  CLIENT: "client",
  DATABASE: "database",
  USER_SETTINGS: "userSettings",
  SHUTDOWN_MANAGER: "shutdownManager",
  SHARD_MANAGER: "shardManager",
  RATE_LIMIT_MANAGER: "rateLimitManager",
  THREAD_MANAGER: "threadManager",
  CONFIG: "config",
  LOGGER: "logger",
  MESSAGE_ROUTER: "messageRouter",
  EVENT_MANAGER: "eventManager", // Add new key for EventManager
} as const;

// Type-safe service registry keys
export type ServiceKey = (typeof SERVICE_KEYS)[keyof typeof SERVICE_KEYS];

// Type mapping for known services
interface ServiceTypes {
  [SERVICE_KEYS.CLIENT]: Client;
  [SERVICE_KEYS.DATABASE]: Database;
  [SERVICE_KEYS.USER_SETTINGS]: UserSettings;
  [SERVICE_KEYS.SHUTDOWN_MANAGER]: ShutdownManager;
  [SERVICE_KEYS.SHARD_MANAGER]: ShardingManager;
  [SERVICE_KEYS.RATE_LIMIT_MANAGER]: RateLimitManager;
  [SERVICE_KEYS.THREAD_MANAGER]: ThreadManager;
  [SERVICE_KEYS.CONFIG]: ConfigFile;
  [SERVICE_KEYS.LOGGER]: Log76;
  [SERVICE_KEYS.MESSAGE_ROUTER]: MessageRouter;
  [SERVICE_KEYS.EVENT_MANAGER]: typeof EventManager; // Add EventManager type
}

// Store services in a private collection
const _services = new Collection<ServiceKey, unknown>();

// Track recovery attempts to prevent infinite loops
const _recoveryAttempts = new Collection<ServiceKey, number>();
const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Options for getting a service from the registry
 */
interface GetServiceOptions {
  /** Whether the service is required (throws if not found) */
  required?: boolean;
  /** Fallback value if service is not found and not required */
  fallback?: unknown;
  /** Whether to report errors if service is not found */
  reportErrors?: boolean;
  /** Custom error context for reporting */
  errorContext?: string;
  /** Whether to attempt recovery for critical services */
  attemptRecovery?: boolean;
}

/**
 * Register a service in the service registry
 */
export function register<K extends ServiceKey>(key: K, service: ServiceTypes[K]): void {
  _services.set(key, service);
}

/**
 * Check if a service is available in the registry
 */
export function isAvailable<K extends ServiceKey>(key: K): boolean {
  return _services.has(key);
}

/**
 * Attempt to dynamically create and register the rateLimitManager
 * This is a recovery mechanism for when the service is missing but required
 */
function recoverRateLimitManager(): boolean {
  try {
    // Check if already registered (avoid race conditions)
    if (_services.has(SERVICE_KEYS.RATE_LIMIT_MANAGER)) {
      void safeLog("debug", "RateLimitManager already registered, recovery not needed");
      return true;
    }

    // Check if we've already tried recovery too many times
    const attempts = _recoveryAttempts.get(SERVICE_KEYS.RATE_LIMIT_MANAGER) || 0;
    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      void safeLog(
        "warn",
        `Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) reached for rateLimitManager`
      );
      return false;
    }

    // Increment attempt counter
    _recoveryAttempts.set(SERVICE_KEYS.RATE_LIMIT_MANAGER, attempts + 1);

    // Check if logger and config are available - these are required for rateLimitManager
    if (!isAvailable(SERVICE_KEYS.LOGGER)) {
      void safeLog("warn", "Cannot recover rateLimitManager: logger service not available");
      return false;
    }

    void safeLog("info", "Attempting to recover missing rateLimitManager service");

    // Dynamically import the RateLimitManager to avoid circular dependencies
    // Using getRateLimitManager to ensure we get the singleton instance
    import("./utilities/rateLimitManager")
      .then(({ getRateLimitManager }) => {
        // Double check to avoid race conditions
        if (!_services.has(SERVICE_KEYS.RATE_LIMIT_MANAGER)) {
          // Use the singleton getter function, not the class constructor
          const manager = getRateLimitManager();
          register(SERVICE_KEYS.RATE_LIMIT_MANAGER, manager);
          void safeLog("info", "Successfully recovered rateLimitManager service");
        } else {
          void safeLog(
            "debug",
            "RateLimitManager was registered by another process during recovery"
          );
        }
      })
      .catch((err) => {
        void safeLog("error", `Failed to dynamically import rateLimitManager: ${err}`);
      });

    // Return false since the recovery is asynchronous and not immediately available
    return false;
  } catch (error) {
    void safeLog(
      "error",
      `Error recovering rateLimitManager: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Get a service from the registry with graceful error handling
 * @param key The service key to retrieve
 * @param options Options for configuring the get behavior
 * @returns The requested service, or fallback value if provided and service not found
 * @throws Error if service is not found and options.required is true
 */
export async function get<K extends ServiceKey>(
  key: K,
  options: GetServiceOptions = {}
): Promise<ServiceTypes[K]> {
  const {
    required = true,
    fallback = undefined,
    reportErrors = true,
    errorContext = `ServiceRegistry:get:${key}`,
    attemptRecovery = true,
  } = options;

  const service = _services.get(key);

  if (!service) {
    const errorMessage = `Service ${key} is not registered`;

    // Keep service lookup logging safe while the logger service initializes.
    void safeLog("warn", `${errorMessage} - ${required ? "required service" : "using fallback"}`);

    // Special case: For rateLimitManager, attempt recovery if enabled
    if (key === SERVICE_KEYS.RATE_LIMIT_MANAGER && attemptRecovery) {
      const recovered = recoverRateLimitManager();
      if (recovered) {
        void safeLog("info", `Successfully recovered ${key} service`);
        return _services.get(key) as ServiceTypes[K];
      } else if (required) {
        void safeLog(
          "warn",
          `Recovery attempted for ${key} but not immediately available. Using existing instance or creating placeholder.`
        );

        // Instead of creating a new instance directly, try to import the singleton
        try {
          // Use dynamic import to avoid circular dependencies
          const rateLimitManagerModule = await import("./utilities/rateLimitManager");
          // Use the getter function to get the singleton instance
          const placeholderManager = rateLimitManagerModule.getRateLimitManager();
          register(SERVICE_KEYS.RATE_LIMIT_MANAGER, placeholderManager);
          return placeholderManager as ServiceTypes[K];
        } catch (importError) {
          void safeLog("error", `Failed to import rateLimitManager: ${importError}`);
          throw new Error(errorMessage, { cause: importError });
        }
      }
    }

    // Report the error if configured to do so
    if (reportErrors) {
      try {
        const error = new Error(errorMessage);
        reportError(error, errorContext);
      } catch (reportingError) {
        // If reporting fails, log but continue
        void safeLog("debug", `Error while reporting service registry error: ${reportingError}`);
      }
    }

    // If the service is required, throw an error
    if (required) {
      throw new Error(errorMessage);
    }

    // Otherwise return the fallback value
    return fallback as ServiceTypes[K];
  }

  return service as ServiceTypes[K];
}

/**
 * Get a service from the registry synchronously
 * @param key The service key to retrieve
 * @returns The requested service or undefined if not found
 *
 * Note: This is a synchronous version of the get method, use with caution
 * and only when you know the service is already registered.
 */
export function getSync<K extends ServiceKey>(key: K): ServiceTypes[K] | undefined {
  return _services.get(key) as ServiceTypes[K] | undefined;
}

/**
 * Try to get a service without throwing an error if it's not available
 * @param key The service key to retrieve
 * @param reportError Whether to report an error if the service is not found
 * @returns The service or undefined if not found
 */
export async function tryGet<K extends ServiceKey>(
  key: K,
  reportError = false
): Promise<ServiceTypes[K] | undefined> {
  return get(key, {
    required: false,
    reportErrors: reportError,
    errorContext: `ServiceRegistry:tryGet:${key}`,
  });
}

// Utility function for user settings availability check (commonly used)
export function isUserSettingsAvailable(): boolean {
  return isAvailable(SERVICE_KEYS.USER_SETTINGS);
}

// Export the service registry as a unified object
export const serviceRegistry = {
  register,
  isAvailable,
  get,
  tryGet,
  isUserSettingsAvailable,
  keys: SERVICE_KEYS,
  getSync, // Add the synchronous method to the object
};

/**
 * USAGE GUIDELINES:
 * 1. Don't access services at module level to avoid circular dependencies
 * 2. Access services inside functions using this registry
 * 3. For files susceptible to circular dependencies, consider dynamic imports
 *
 * @example
 * // Inside a function, not at module level:
 * const logger = await serviceRegistry.get(SERVICE_KEYS.LOGGER);
 * const database = await serviceRegistry.get(SERVICE_KEYS.DATABASE);
 */
