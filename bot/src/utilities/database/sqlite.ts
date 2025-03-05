import { ChannelData, Database, ThreadData } from "../../interfaces/database"; // Fix import path
import sql, { Database as sqliteDatabase } from "better-sqlite3";
import { ConfigFile } from "../cnf/index";
import { join } from "path";
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

  constructor(config: ConfigFile) {
    const dbPath = join(config.database.options.dataLocation, "data.db");
    this.db = sql(dbPath);
  }

  createTables(): Promise<void> {
    return new Promise((resolve) => {
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, server TEXT, dueArchive INTEGER, watching INTEGER)",
        )
        .run();
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, server TEXT, regex TEXT, roles TEXT, tags TEXT)",
        )
        .run();
      this.db.prepare(
        "CREATE TABLE IF NOT EXISTS blacklist (id TEXT PRIMARY KEY, reason TEXT)",
      );
      // we aint normalising this bitch
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS config (server TEXT, cfg_id TEXT, value TEXT, PRIMARY KEY (server, cfg_id))",
        )
        .run();
      resolve();
    });
  }

  setConfigValue(server: string, key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      this.db
        .prepare("REPLACE INTO config VALUES(?,?,?)")
        .run(server, key, value);
      resolve();
    });
  }

  deleteConfigValue(server: string, key: string): Promise<void> {
    return new Promise((resolve) => {
      this.db
        .prepare("DELETE FROM config WHERE server = ? AND cfg_id = ?")
        .run(server, key);
      resolve();
    });
  }

  getConfigValue(server: string, key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const res = this.db
        .prepare("SELECT * FROM config WHERE server = ? AND cfg_id = ?")
        .get(server, key) as { server: string; cfg_id: string; value: string };
      if (!res) return reject("NO ROW FOUND");
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

  insertThread(id: string, dueArchive: number, server: string): Promise<void> {
    return new Promise((resolve) => {
      this.db
        .prepare("REPLACE INTO threads VALUES(?,?,?,1)")
        .run(id, server, dueArchive);
      resolve();
    });
  }

  updateDueArchive(id: string, dueArchive: number): Promise<void> {
    return new Promise((resolve) => {
      this.db
        .prepare("UPDATE threads SET dueArchive = ? WHERE id = ?")
        .run(dueArchive, id);
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
          }),
      );
      resolve(returnArr);
    });
  }

  getThreads(server: string): Promise<ThreadData[]> {
    return new Promise((resolve) => {
      const returnArr: ThreadData[] = [];
      returnArr.push(
        ...(this.db
          .prepare("SELECT * FROM threads WHERE server = ?")
          .all(server) as ThreadData[]),
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
      this.db
        .prepare("UPDATE threads SET watching = 0 WHERE id = ?")
        .run(threadID);
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
   * Get all threads that are being watched
   */
  getAllWatchedThreads(): Promise<ThreadData[]> {
    return new Promise((resolve) => {
      const threads = this.db
        .prepare("SELECT id, server, dueArchive, watching FROM threads WHERE watching = 1")
        .all() as ThreadRow[];
      
      resolve(threads.map(thread => ({
        id: thread.id,
        server: thread.server,
        dueArchive: thread.dueArchive,
        watching: Boolean(thread.watching)
      })));
    });
  }

  // Implement close method if not already present
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close();
      resolve();
    });
  }
}

export default sqlite;
