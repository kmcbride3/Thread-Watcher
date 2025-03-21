import sql, { Database as sqliteDatabase } from "better-sqlite3";
import { join } from "path";
import { logger } from "../../index";
import { ChannelData, Database, ThreadData } from "../../interfaces/database";
import { ConfigFile } from "../cnf/index";
import { getBackupName } from "./DatabaseManager";

// Type for internal database rows
interface ChannelRow {
  id: string;
  server: string;
  regex?: string;
  roles?: string;
  tags?: string;
}

interface ThreadRow {
  id: string;
  server: string;
  dueArchive: number;
  watching: number;
}

class sqlite implements Database {
  db: sqliteDatabase;
  private isReady = false;
  private readyPromise: Promise<void> | null = null;

  constructor(config: ConfigFile) {
    const dbPath = join(config.database.options.dataLocation, "data.db");
    this.db = sql(dbPath);

    // Initialize the database with schema migration support
    this.readyPromise = this.init().then(() => {
      this.isReady = true;
    });
  }

  /**
   * Initialize the database with schema checks and migrations
   * @private
   */
  private async init(): Promise<void> {
    // Create the basic tables
    await this.createTables();

    // No need to migrate or populate shardIds anymore
    // as we're not storing them in the database
  }

  /**
   * Ensures the database is ready before running queries
   */
  async waitForReady(): Promise<void> {
    if (this.isReady) return;
    if (this.readyPromise) await this.readyPromise;
  }

  createTables(): Promise<void> {
    return new Promise((resolve) => {
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, server TEXT, dueArchive INTEGER, watching INTEGER)"
        )
        .run();
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, server TEXT, regex TEXT, roles TEXT, tags TEXT)"
        )
        .run();
      this.db
        .prepare("CREATE TABLE IF NOT EXISTS blacklist (id TEXT PRIMARY KEY, reason TEXT)")
        .run();
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS config (server TEXT, cfg_id TEXT, value TEXT, PRIMARY KEY (server, cfg_id))"
        )
        .run();
      resolve();
    });
  }

  setConfigValue(server: string, key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      this.db.prepare("REPLACE INTO config VALUES(?,?,?)").run(server, key, value);
      resolve();
    });
  }

  deleteConfigValue(server: string, key: string): Promise<void> {
    return new Promise((resolve) => {
      this.db.prepare("DELETE FROM config WHERE server = ? AND cfg_id = ?").run(server, key);
      resolve();
    });
  }

  getConfigValue(server: string, key: string): Promise<string> {
    return new Promise((resolve) => {
      const res = this.db
        .prepare("SELECT * FROM config WHERE server = ? AND cfg_id = ?")
        .get(server, key) as { server: string; cfg_id: string; value: string } | undefined;
      if (!res) {
        // Change from warn to debug level since this is expected for new servers
        logger.debug(`Config value for ${server}/${key} not found; using default value`);
        // Return a default value here. Adjust default as needed.
        resolve("");
        return;
      }
      resolve(res.value);
    });
  }

  insertChannel(data: ChannelData): Promise<void> {
    return new Promise((resolve) => {
      const { id, server, regex, roles, tags } = data;
      this.db
        .prepare("REPLACE INTO channels VALUES(?,?, ?, ?, ?)")
        .run(id, server, regex, roles.join(","), tags.join(","));
      resolve();
    });
  }

  /**
   * Insert a thread into the database (without shardId)
   */
  async insertThread(id: string, dueArchive: number, server: string): Promise<void> {
    await this.waitForReady();
    const query = `
      INSERT OR REPLACE INTO threads (id, dueArchive, server, watching)
      VALUES (?, ?, ?, ?)
    `;

    this.db.prepare(query).run(id, dueArchive, server, 1);
  }

  updateDueArchive(id: string, dueArchive: number): Promise<void> {
    return new Promise((resolve) => {
      this.db.prepare("UPDATE threads SET dueArchive = ? WHERE id = ?").run(dueArchive, id);
      resolve();
    });
  }

  getChannels(server: string): Promise<ChannelData[]> {
    return new Promise((resolve) => {
      const returnArr: ChannelData[] = [];
      returnArr.push(
        ...this.db
          .prepare("SELECT * FROM channels WHERE server = ?")
          .all(server)
          .map((i) => {
            const item: ChannelRow = i as ChannelRow;
            const rv: ChannelData = {
              id: item.id,
              server: item.server, // Keep using server field name
              regex: item?.regex || "",
              tags: item?.tags?.split(",") || [],
              roles: item?.roles?.split(",") || [],
            };
            return rv;
          })
      );
      resolve(returnArr);
    });
  }

  getThreads(server: string): Promise<ThreadData[]> {
    return new Promise((resolve) => {
      const returnArr: ThreadData[] = [];
      returnArr.push(
        ...(this.db.prepare("SELECT * FROM threads WHERE server = ?").all(server) as ThreadData[])
      );
      resolve(returnArr);
    });
  }

  deleteThread(threadID: string): Promise<void> {
    return new Promise((resolve) => {
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(threadID);
      resolve();
    });
  }

  deleteChannel(channelID: string): Promise<void> {
    return new Promise((resolve) => {
      this.db.prepare("DELETE FROM channels WHERE id = ?").run(channelID);
      resolve();
    });
  }

  deleteGuild(server: string): Promise<void> {
    return new Promise((resolve) => {
      this.db.prepare("DELETE FROM channels WHERE server = ?").all(server);
      this.db.prepare("DELETE FROM threads WHERE server = ?").all(server);
      resolve();
    });
  }

  unwatchThread(threadID: string): Promise<void> {
    return new Promise((resolve) => {
      this.db.prepare("UPDATE threads SET watching = 0 WHERE id = ?").run(threadID);
      resolve();
    });
  }

  getNumberOfThreads(): Promise<number> {
    return new Promise((resolve) => {
      const res = this.db.prepare("SELECT COUNT(*) FROM threads;").all();

      let count = res[0];
      if (count) count = Object.values(res[0] as [number, string])[0];
      else count = NaN;

      resolve(count as number);
    });
  }

  getNumberOfChannels(): Promise<number> {
    return new Promise((resolve) => {
      const res = this.db.prepare("SELECT COUNT(*) FROM channels;").all();

      let count = res[0];
      if (count) count = Object.values(res[0] as [number, string])[0];
      else count = NaN;

      resolve(count as number);
    });
  }

  createBackup(baseDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const backupPath = `${join(baseDir, getBackupName())}.db`;
      this.db
        .backup(backupPath)
        .then(() => {
          resolve(backupPath);
        })
        .catch(reject);
    });
  }

  /**
   * Get all watched threads from the database (no shardId)
   */
  async getAllWatchedThreads(): Promise<ThreadData[]> {
    await this.waitForReady();

    const rows = this.db
      .prepare(
        `
      SELECT id, dueArchive, server, watching
      FROM threads
      WHERE watching = 1
    `
      )
      .all() as ThreadRow[];

    return rows.map((row) => ({
      id: row.id,
      dueArchive: row.dueArchive ?? 0, // Ensure dueArchive is never undefined
      server: row.server,
      watching: Boolean(row.watching),
    }));
  }

  // Implement close method if not already present
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close();
      resolve();
    });
  }

  /**
   * Check if a channel is being watched
   */
  async isChannelWatched(channelId: string, guildId: string): Promise<boolean> {
    if (!channelId || !guildId) {
      return false;
    }

    try {
      await this.waitForReady();
      const result = this.db
        .prepare("SELECT COUNT(*) as count FROM channels WHERE id = ? AND server = ?")
        .get(channelId, guildId) as { count: number };

      return result && result.count > 0;
    } catch (error) {
      logger.warn(`Error checking if channel ${channelId} is watched: ${error}`);
      return false;
    }
  }
}

export default sqlite;
