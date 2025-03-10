import { spawn } from "child_process";
import { Collection } from "discord.js";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { createPool, Pool, PoolConnection, QueryOptions } from "mysql";
import { join } from "path";
import { ChannelData, Database, ThreadData } from "../../interfaces/database";
import { handleApiError } from "../apiErrorHandler";
import { ConfigFile } from "../cnf/index";
import { Log76 } from "../logger";
import { rateLimitManager } from "../rateLimitManager";
import { getBackupName } from "./DatabaseManager";

interface ThreadRow {
  id: string;
  server: string;
  watching: number | boolean;
  dueArchive: number;
}

export default class mysql implements Database {
  connection: Pool;
  database: string;
  private config: ConfigFile;
  private connDetails: {
    host: string;
    user: string;
    password: string;
    database: string;
  };
  private logger: Log76;
  private queryCache = new Collection<string, { data: unknown; timestamp: number }>();
  private readonly cacheTTL = 30000; // 30 seconds cache lifetime
  private preparedStatements = new Collection<string, string>();

  constructor(config: ConfigFile, logger: Log76) {
    const { host, user, password, database } = config.database.options;

    if (!host || !user || !database) {
      logger.error("Database configuration is incomplete");
      throw new Error("Invalid database configuration");
    }

    this.database = database;
    this.connDetails = { host, user, password, database };
    this.config = config;
    this.logger = logger;

    this.connection = createPool({
      host,
      user,
      password,
      database,
      connectionLimit: 10,
      charset: "utf8mb4",
      multipleStatements: true,
      connectTimeout: 10000,
      acquireTimeout: 10000,
      waitForConnections: true,
      queueLimit: 0,
    });

    this.initPreparedStatements();

    setInterval(() => this.cleanupCache(), 60000);
  }

  /**
   * Initialize prepared statements for better performance and security
   * @private
   */
  private initPreparedStatements(): void {
    this.preparedStatements.set(
      "getAllThreads",
      "SELECT id, server, dueArchive, watching FROM threads WHERE watching = 1"
    );
    this.preparedStatements.set(
      "getThreads",
      "SELECT * FROM threads WHERE server = ? AND watching = 1"
    );
    this.preparedStatements.set("insertThread", "REPLACE INTO threads VALUES(?, ?, ?, TRUE)"); // Use TRUE instead of true for SQL compatibility
    this.preparedStatements.set("deleteThread", "DELETE FROM threads WHERE id = ?");
    this.preparedStatements.set("unwatchThread", "UPDATE threads SET watching = 0 WHERE id = ?");
    this.preparedStatements.set(
      "updateThreadDue",
      "UPDATE threads SET dueArchive = ? WHERE id = ?"
    );

    this.preparedStatements.set("getChannels", "SELECT * FROM channels WHERE server = ?");
    this.preparedStatements.set("insertChannel", "REPLACE INTO channels VALUES(?, ?, ?, ?, ?)");
    this.preparedStatements.set("deleteChannel", "DELETE FROM channels WHERE id = ?");

    this.preparedStatements.set(
      "getConfig",
      "SELECT * FROM config WHERE server = ? AND cfg_id = ?"
    );
    this.preparedStatements.set("setConfig", "INSERT INTO config VALUES(?, ?, ?)");
    this.preparedStatements.set(
      "deleteConfig",
      "DELETE FROM config WHERE server = ? AND cfg_id = ?"
    );

    this.preparedStatements.set("countThreads", "SELECT COUNT(*) AS count FROM threads");
    this.preparedStatements.set("countChannels", "SELECT COUNT(*) AS count FROM channels");
  }

  /**
   * Clean up expired cache entries
   * @private
   */
  private cleanupCache(): void {
    try {
      const now = Date.now();
      const expiredCount = this.queryCache.sweep((entry) => now - entry.timestamp > this.cacheTTL);
      if (expiredCount > 0) {
        this.logger.trace(`Cleaned up ${expiredCount} expired database cache entries`);
      }
    } catch (error) {
      this.logger.error(`Error during cache cleanup: ${String(error)}`);
    }
  }

  /**
   * Get a connection from the pool with better error handling
   * @private
   */
  private async getConnection(): Promise<PoolConnection> {
    return await handleApiError(
      "Failed to get database connection",
      () => {
        return new Promise<PoolConnection>((resolve, reject) => {
          this.connection.getConnection((err, connection) => {
            if (err) {
              reject(err);
            } else {
              resolve(connection);
            }
          });
        });
      },
      3, // retries
      1000 // delay
    );
  }

  /**
   * Execute a query with automatic connection management and error handling
   * @private
   */
  private async query<T>(
    sql: string,
    params: unknown[] = [],
    options: {
      useCache?: boolean;
      cacheKey?: string;
      rateLimit?: string;
    } = {}
  ): Promise<T> {
    const rateLimitKey = options.rateLimit || "db/query";

    if (options.useCache && options.cacheKey && this.queryCache.has(options.cacheKey)) {
      const cached = this.queryCache.get(options.cacheKey);
      if (cached && cached.timestamp > Date.now() - this.cacheTTL) {
        return cached.data as T;
      }
    }

    // Wait for rate limit
    await rateLimitManager.waitForRateLimit(rateLimitKey);

    return handleApiError(
      "Database query failed",
      async () => {
        const connection = await this.getConnection();

        try {
          const result = await new Promise<T>((resolve, reject) => {
            const queryOptions: QueryOptions = {
              sql,
              values: params,
              timeout: 5000, // 5 second query timeout
            };

            connection.query(queryOptions, (err, results) => {
              if (err) {
                reject(err);
              } else {
                resolve(results as T);
              }
            });
          });

          if (options.useCache && options.cacheKey) {
            this.queryCache.set(options.cacheKey, {
              data: result,
              timestamp: Date.now(),
            });
          }

          return result;
        } finally {
          connection.release();
        }
      },
      3, // retries
      1000 // delay
    );
  }

  async createTables(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS \`threads\` (
        \`id\` VARCHAR(32) NOT NULL,
        \`server\` VARCHAR(32) NOT NULL,
        \`dueArchive\` BIGINT NOT NULL,
        \`watching\` BOOLEAN DEFAULT 1,
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      
      CREATE TABLE IF NOT EXISTS \`channels\` (
        \`id\` VARCHAR(32) NOT NULL,
        \`server\` VARCHAR(32) NOT NULL,
        \`regex\` TEXT,
        \`roles\` TEXT,
        \`tags\` TEXT,
        PRIMARY KEY (\`id\`),
        INDEX server_idx (\`server\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      
      CREATE TABLE IF NOT EXISTS \`config\` (
        \`server\` VARCHAR(32) NOT NULL,
        \`cfg_id\` VARCHAR(64) NOT NULL,
        \`value\` TEXT NOT NULL,
        PRIMARY KEY(\`server\`, \`cfg_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    await this.query(sql, [], { rateLimit: "db/schema" });
    this.logger.debug("MySQL database tables initialized or verified");
  }

  /**
   * Set a config value with improved error handling
   */
  async setConfigValue(guildID: string, key: string, value: string): Promise<void> {
    if (!guildID || !key) {
      throw new Error("Guild ID and key are required");
    }

    const sql = this.preparedStatements.get("setConfig") || "INSERT INTO config VALUES(?,?,?)";
    await this.query(sql, [guildID, key, value], { rateLimit: "db/config/set" });

    this.queryCache.delete(`config_${guildID}_${key}`);
  }

  /**
   * Delete a config value with improved error handling
   */
  async deleteConfigValue(guildID: string, key: string): Promise<void> {
    if (!guildID || !key) {
      throw new Error("Guild ID and key are required");
    }

    const sql =
      this.preparedStatements.get("deleteConfig") ||
      "DELETE FROM config WHERE server = ? AND cfg_id = ?";
    await this.query(sql, [guildID, key], { rateLimit: "db/config/delete" });

    this.queryCache.delete(`config_${guildID}_${key}`);
  }

  /**
   * Get a config value with consistent error handling
   */
  async getConfigValue(guildID: string, key: string): Promise<string> {
    if (!guildID || !key) {
      throw new Error("Guild ID and key are required");
    }

    const sql =
      this.preparedStatements.get("getConfig") ||
      "SELECT * FROM config WHERE server = ? AND cfg_id = ?";

    const cacheKey = `config_${guildID}_${key}`;

    const res = await this.query<{ server: string; cfg_id: string; value: string }[]>(
      sql,
      [guildID, key],
      { useCache: true, cacheKey, rateLimit: "db/config/get" }
    );

    if (res && res.length > 0 && res[0]) {
      return res[0].value;
    }

    throw "NO ROW FOUND";
  }

  /**
   * Insert a channel with validation
   */
  async insertChannel(data: ChannelData): Promise<void> {
    if (!data.id || !data.server) {
      throw new Error("Channel ID and server are required");
    }

    const { id, server, regex, roles, tags } = data;
    const sql =
      this.preparedStatements.get("insertChannel") || "REPLACE INTO channels VALUES(?,?,?,?,?)";

    const roleList = Array.isArray(roles) ? roles : [];
    const tagList = Array.isArray(tags) ? tags : [];

    await this.query(sql, [id, server, regex || "", roleList.join(","), tagList.join(",")], {
      rateLimit: "db/channels/insert",
    });

    this.queryCache.delete(`channels_${server}`);
  }

  /**
   * Insert thread with validation
   */
  async insertThread(id: string, dueArchive: number, server: string): Promise<void> {
    if (!id || !server) {
      throw new Error("Thread ID and server are required");
    }

    const sql =
      this.preparedStatements.get("insertThread") || "REPLACE INTO threads VALUES(?,?,?,TRUE)";
    await this.query(sql, [id, server, dueArchive], { rateLimit: "db/threads/insert" });

    this.queryCache.delete("all_watched_threads");
    this.queryCache.delete(`threads_${server}`);
  }

  /**
   * Update thread archive time with validation
   */
  async updateDueArchive(id: string, dueArchive: number): Promise<void> {
    if (!id) {
      throw new Error("Thread ID is required");
    }

    const sql =
      this.preparedStatements.get("updateThreadDue") ||
      "UPDATE threads SET dueArchive = ? WHERE id = ?";
    await this.query(sql, [dueArchive, id], { rateLimit: "db/threads/updateDue" });

    this.queryCache.delete("all_watched_threads");
  }

  /**
   * Get channels with strong typing
   */
  async getChannels(server: string): Promise<ChannelData[]> {
    if (!server) {
      throw new Error("Server ID is required");
    }

    const sql =
      this.preparedStatements.get("getChannels") || "SELECT * FROM channels WHERE server = ?";

    const cacheKey = `channels_${server}`;

    interface RawChannelData {
      id: string;
      server: string;
      regex?: string | null;
      roles?: string | null;
      tags?: string | null;
    }

    const res = await this.query<RawChannelData[]>(sql, [server], {
      useCache: true,
      cacheKey,
      rateLimit: "db/channels/get",
    });

    // Handle case where query returns null
    if (!res) {
      return [];
    }

    return res.map((row) => ({
      id: row.id,
      server: row.server,
      regex: row.regex || "",
      tags: row.tags?.split(",").filter(Boolean) || [],
      roles: row.roles?.split(",").filter(Boolean) || [],
    }));
  }

  /**
   * Get threads with error handling
   */
  async getThreads(server: string): Promise<ThreadData[]> {
    if (!server) {
      throw new Error("Server ID is required");
    }

    const sql =
      this.preparedStatements.get("getThreads") ||
      "SELECT * FROM threads WHERE server = ? AND watching = 1";

    const result = await this.query<ThreadData[]>(sql, [server], {
      useCache: true,
      cacheKey: `threads_${server}`,
      rateLimit: "db/threads/get",
    });

    return result || [];
  }

  async deleteThread(threadID: string): Promise<void> {
    const sql = this.preparedStatements.get("deleteThread") || "DELETE FROM threads WHERE id = ?";
    await this.query(sql, [threadID], { rateLimit: "db/threads/delete" });

    this.queryCache.delete("all_watched_threads");
  }

  async deleteChannel(channelID: string): Promise<void> {
    const channel = await this.query<{ server: string }[]>(
      "SELECT server FROM channels WHERE id = ? LIMIT 1",
      [channelID],
      { rateLimit: "db/channels/get" }
    );

    const sql = this.preparedStatements.get("deleteChannel") || "DELETE FROM channels WHERE id = ?";
    await this.query(sql, [channelID], { rateLimit: "db/channels/delete" });

    if (channel.length > 0) {
      this.queryCache.delete(`channels_${channel[0].server}`);
    }
  }

  async deleteGuild(server: string): Promise<void> {
    await Promise.all([
      this.query("DELETE FROM channels WHERE server = ?", [server], {
        rateLimit: "db/guild/delete",
      }),
      this.query("DELETE FROM threads WHERE server = ?", [server], {
        rateLimit: "db/guild/delete",
      }),
      this.query("DELETE FROM config WHERE server = ?", [server], { rateLimit: "db/guild/delete" }),
    ]);

    this.queryCache.delete(`channels_${server}`);
    this.queryCache.delete(`threads_${server}`);
    this.queryCache.delete("all_watched_threads");
  }

  async unwatchThread(threadID: string): Promise<void> {
    const sql =
      this.preparedStatements.get("unwatchThread") ||
      "UPDATE threads SET watching = 0 WHERE id = ?";
    await this.query(sql, [threadID], { rateLimit: "db/threads/unwatch" });

    this.queryCache.delete("all_watched_threads");
  }

  /**
   * Get count of threads with proper type casting
   */
  async getNumberOfThreads(): Promise<number> {
    const sql =
      this.preparedStatements.get("countThreads") || "SELECT COUNT(*) AS count FROM threads";
    const res = await this.query<{ count: number }[]>(sql, [], {
      useCache: true,
      cacheKey: "thread_count",
      rateLimit: "db/stats",
    });

    if (res && res.length > 0 && res[0] && typeof res[0].count === "number") {
      return res[0].count;
    }

    return 0; // Default to 0 if no valid result
  }

  /**
   * Get count of channels with proper type casting
   */
  async getNumberOfChannels(): Promise<number> {
    const sql =
      this.preparedStatements.get("countChannels") || "SELECT COUNT(*) AS count FROM channels";
    const res = await this.query<{ count: number }[]>(sql, [], {
      useCache: true,
      cacheKey: "channel_count",
      rateLimit: "db/stats",
    });

    // Safely access the count value
    if (res && res.length > 0 && res[0] && typeof res[0].count === "number") {
      return res[0].count;
    }

    return 0; // Default to 0 if no valid result
  }

  async backup(options: { path: string }): Promise<boolean> {
    // Create the directory if it doesn't exist
    if (!existsSync(options.path)) {
      mkdirSync(options.path, { recursive: true });
    }

    // Get the current date for the filename
    const date = new Date();
    const filename = `backup-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}.sql`;
    const filepath = join(options.path, filename);

    await rateLimitManager.waitForRateLimit("db/backup");

    return handleApiError(
      "Database backup failed",
      () => {
        // Security: Only allow predefined parameters from configuration
        // Use a safer approach with spawn instead of exec
        const mysqlDump = spawn("mysqldump", [
          `-h${this.connDetails.host}`,
          `-u${this.connDetails.user}`,
          `-p${this.connDetails.password}`,
          `${this.connDetails.database}`,
        ]);

        // Pipe the output to a file stream
        const fileStream = createWriteStream(filepath);
        mysqlDump.stdout.pipe(fileStream);

        return new Promise<boolean>((resolve) => {
          mysqlDump.stderr.on("data", (data) => {
            this.logger.error(`mysqldump error: ${data}`);
          });

          mysqlDump.on("close", (code) => {
            if (code === 0) {
              this.logger.done(`MySQL Backup Created: ${filename}`);
              resolve(true);
            } else {
              this.logger.error(`mysqldump failed with code ${code}`);
              resolve(false);
            }
          });
        });
      },
      2, // retries
      5000 // delay
    );
  }

  async createBackup(baseDir: string): Promise<string> {
    const backupPath = join(baseDir, `${getBackupName()}.sql`);

    const success = await this.backup({ path: baseDir });
    if (!success) {
      throw new Error("Backup failed");
    }

    return backupPath;
  }

  /**
   * Get all watched threads with stronger typing
   */
  async getAllWatchedThreads(): Promise<ThreadData[]> {
    const sql =
      this.preparedStatements.get("getAllThreads") ||
      "SELECT id, server, dueArchive, watching FROM threads WHERE watching = 1";

    const res = await this.query<ThreadRow[]>(sql, [], {
      useCache: true,
      cacheKey: "all_watched_threads",
      rateLimit: "db/threads/getAll",
    });

    if (!res) {
      return [];
    }

    return res.map((row: ThreadRow) => ({
      id: row.id,
      server: row.server,
      dueArchive: Number(row.dueArchive),
      watching: Boolean(row.watching),
    }));
  }

  /**
   * Clean up resources with improved error handling
   */
  async close(): Promise<void> {
    this.queryCache.clear();

    if (!this.connection) {
      this.logger.debug("No active database connection to close");
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.connection.end((err) => {
        if (err) {
          this.logger.error(`Error closing database connection: ${String(err)}`);
          return reject(err);
        }
        this.logger.debug("Database connections closed successfully");
        return resolve();
      });
    });
  }
}
