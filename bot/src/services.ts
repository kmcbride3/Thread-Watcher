import { Client, Collection, ShardingManager } from "discord.js";
import { logger } from "./index";
import { Database } from "./interfaces/database";
import { ConfigFile } from "./utilities/cnf";
import { reportError } from "./utilities/errorReporter";
import { Log76 } from "./utilities/logger";
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
}

// Store services in a private collection
const _services = new Collection<ServiceKey, unknown>();

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
 * Get a service from the registry with graceful error handling
 * @param key The service key to retrieve
 * @param options Options for configuring the get behavior
 * @returns The requested service, or fallback value if provided and service not found
 * @throws Error if service is not found and options.required is true
 */
export function get<K extends ServiceKey>(
  key: K,
  options: GetServiceOptions = {}
): ServiceTypes[K] {
  const {
    required = true,
    fallback = undefined,
    reportErrors = true,
    errorContext = `ServiceRegistry:get:${key}`,
  } = options;

  const service = _services.get(key);

  if (!service) {
    const errorMessage = `Service ${key} is not registered`;

    // Log the error (always log for visibility)
    logger.warn(`${errorMessage} - ${required ? "required service" : "using fallback"}`);

    // Report the error if configured to do so
    if (reportErrors) {
      try {
        const error = new Error(errorMessage);
        reportError(error, errorContext);
      } catch (reportingError) {
        // If reporting fails, log but continue
        logger.debug(`Error while reporting service registry error: ${reportingError}`);
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
 * Try to get a service without throwing an error if it's not available
 * @param key The service key to retrieve
 * @param reportError Whether to report an error if the service is not found
 * @returns The service or undefined if not found
 */
export function tryGet<K extends ServiceKey>(
  key: K,
  reportError = false
): ServiceTypes[K] | undefined {
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
};
