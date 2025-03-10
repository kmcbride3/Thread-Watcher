import { ConfigFile } from "../cnf/index";
import { Log76 } from "../logger";
import DiscordMessage from "./backup/discord";
import { Database } from "../../interfaces/database";
import Logger from "log75";
import mysql from "./mysql";
import sqlite from "./sqlite";
import { shutdownManager } from "../../index";

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

/**
 * Create and return a database instance of the specified type
 */
export function getDatabase(type: DataBases, config: ConfigFile, logger?: Logger): Database {
  switch (type) {
    case DataBases.sqlite:
      return new sqlite(config);
    case DataBases.mysql:
      return new mysql(config, logger as Log76);
    default:
      if (logger) {
        logger.error(`Could not get a database implementation for "${DataBases[type]}"`);
      } else {
        console.error(`Could not get a database implementation for "${DataBases[type]}"`);
      }
      shutdownManager.shutdown(1, `Invalid database type: ${DataBases[type]}`);
      throw new Error(`Invalid database type: ${DataBases[type]}`);
  }
}

/**
 * Initialize the database system with chosen implementation
 * @param config Application configuration
 * @param logger Optional logger instance
 * @returns Database instance
 */
export function initializeDatabase(config: ConfigFile, logger?: Logger): Database {
  // Default to SQLite if not specified
  const dbType = config.database?.type ? DataBases[config.database.type] : DataBases.sqlite;

  // Create and return database instance directly
  return getDatabase(dbType, config, logger);
}

export function getBackupProvider(
  type: BackupProviders,
  config: ConfigFile,
  logger?: Logger
): DiscordMessage | undefined {
  if (type === BackupProviders.discord && config.logWebhook !== "")
    return new DiscordMessage(config, logger);
  return undefined;
}
