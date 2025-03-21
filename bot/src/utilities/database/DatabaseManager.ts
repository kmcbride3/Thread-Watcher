import { logger } from "../../index";
import { Database } from "../../interfaces/database";
import { SERVICE_KEYS, serviceRegistry } from "../../services";
import { ConfigFile } from "../cnf/index";
import { Log76 } from "../logger";
import { getProcessContext } from "../processState";
import { ShutdownPriority } from "../shutdown";
import DiscordMessage from "./backup/discord";
import mysql from "./mysql";
import sqlite from "./sqlite";

export enum DataBases {
  sqlite,
  mysql,
}

export enum BackupProviders {
  none,
  discord,
}

export type databaseInstance = sqlite | mysql;

export function getBackupName(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}@${pad(now.getHours())}.${pad(now.getMinutes())}`;
}

const globalLogger = logger;

// Add this section to manage database operation timeouts
interface TimeoutReference {
  id: NodeJS.Timeout;
  operation: string;
  started: number;
  processContext: string; // Add process context to track which process created the timeout
}

// Track active database operation timeouts
const activeTimeouts = new Map<string, TimeoutReference>();

/**
 * Create a timeout for a database operation that will be canceled on success
 * @param operationKey Unique identifier for the operation (e.g., "updateThread-123")
 * @param timeoutMs Milliseconds before timeout triggers
 * @param onTimeout Function to execute if timeout occurs
 * @returns Function to call when operation completes successfully
 */
export function createDatabaseTimeout(
  operationKey: string,
  timeoutMs: number,
  onTimeout: () => void
): () => void {
  // Generate process-specific key to avoid conflicts between main and shards
  const processContext = getProcessContext() ?? "main";
  const processSpecificKey = `${processContext}:${operationKey}`;

  // Clear any existing timeout for this operation
  clearDatabaseTimeout(processSpecificKey);

  // Create new timeout
  const timeoutId = setTimeout(() => {
    activeTimeouts.delete(processSpecificKey);
    logger.debug(`Database timeout triggered for operation: ${operationKey} in ${processContext}`);
    onTimeout();
  }, timeoutMs);

  // Store reference
  activeTimeouts.set(processSpecificKey, {
    id: timeoutId,
    operation: operationKey,
    started: Date.now(),
    processContext,
  });

  logger.trace(`Created database timeout for operation: ${operationKey} in ${processContext}`);

  // Return function to clear timeout when operation succeeds
  return () => clearDatabaseTimeout(processSpecificKey);
}

/**
 * Clear a database operation timeout
 * @param operationKey The key identifying the operation
 * @returns true if a timeout was cleared, false otherwise
 */
export function clearDatabaseTimeout(operationKey: string): boolean {
  // Check if we need to add process context
  const hasProcessContext = operationKey.includes(":");
  const fullKey = hasProcessContext ? operationKey : `${getProcessContext()}:${operationKey}`;

  const timeoutRef = activeTimeouts.get(fullKey);
  if (timeoutRef) {
    clearTimeout(timeoutRef.id);
    activeTimeouts.delete(fullKey);
    logger.debug(
      `Cleared database timeout for operation: ${timeoutRef.operation} in ${timeoutRef.processContext}`
    );
    return true;
  }
  logger.trace(`No timeout found for operation: ${operationKey}`);
  return false;
}

/**
 * Create and return a database instance of the specified type
 */
export function getDatabase(type: DataBases, config: ConfigFile, logger?: Log76): Database {
  const log = logger || globalLogger;

  switch (type) {
    case DataBases.sqlite: {
      return new sqlite(config);
    }
    case DataBases.mysql: {
      return new mysql(config);
    }
    default: {
      if (log) {
        log.error(`Could not get a database implementation for "${DataBases[type]}"`);
      } else {
        // Fallback: if logger is not provided, use a minimal error log
        console.error(`Could not get a database implementation for "${DataBases[type]}"`);
      }

      // Use the service registry to get the shutdown manager
      if (serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
        const shutdownManager = serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER);
        shutdownManager.shutdown(1, `Invalid database type: ${DataBases[type]}`);
      } else {
        // Fallback if shutdown manager isn't available
        throw new Error(`Invalid database type: ${DataBases[type]}`);
      }
      throw new Error(`Invalid database type: ${DataBases[type]}`);
    }
  }
}

/**
 * Initialize the database system with chosen implementation
 * @param config Application configuration
 * @param logger Optional logger instance
 * @returns Database instance
 */
export function initializeDatabase(config: ConfigFile, logger: Log76): Database {
  // Default to SQLite if not specified
  const dbType = config.database?.type ? DataBases[config.database.type] : DataBases.sqlite;

  // Create database instance
  const database = getDatabase(dbType, config, logger);

  // Add the clearTimeout method to the database instance if it doesn't exist
  if (!("clearTimeout" in database)) {
    Object.defineProperty(database, "clearTimeout", {
      value: function (key: string): boolean {
        return clearDatabaseTimeout(key);
      },
      writable: false,
      configurable: false,
    });
  }

  // Make sure we register a shutdown handler to clear database timeouts
  if (serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
    const shutdownManager = serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER);
    shutdownManager.registerCleanupTask(
      async () => {
        // Clear all database timeouts during shutdown
        for (const [key, timeoutRef] of activeTimeouts.entries()) {
          clearTimeout(timeoutRef.id);
          activeTimeouts.delete(key);
          logger.debug(`Cleared database timeout for operation: ${timeoutRef.operation}`);
        }
      },
      {
        name: "Database_Timeout_Cleanup",
        priority: ShutdownPriority.HIGH,
        timeout: 1000,
      }
    );
  }

  return database;
}

export function getBackupProvider(
  type: BackupProviders,
  config: ConfigFile,
  logger?: Log76
): DiscordMessage | undefined {
  if (type === BackupProviders.discord && config.logWebhook !== "")
    return new DiscordMessage(config, logger);
  return undefined;
}
