import { ChannelData, Database, ThreadData } from "../../interfaces/database";
import { createPool, Pool } from "mysql";
import { ConfigFile } from "../cnf/index";
import { join } from "path";
import { getBackupName } from "./DatabaseManager";
import { spawn } from "child_process";
import { existsSync, mkdirSync, createWriteStream } from "fs";
import { Log76 } from "../logger";

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

  constructor(config: ConfigFile, logger: Log76) {
    const { host, user, password, database } = config.database.options;

    this.database = database;
    this.connDetails = { host, user, password, database };
    this.config = config;
    this.logger = logger;

    this.connection = createPool({
      host,
      user,
      password,
      database,
    });
  }

  createTables(): Promise<void> {
    return new Promise((resolve) => {
      this.connection.query(
        `CREATE TABLE IF NOT EXISTS \`${this.database}\`.\`threads\` (\`id\` VARCHAR(20) NOT NULL, \`server\` VARCHAR(20) NOT NULL, \`dueArchive\` INT NOT NULL, watching BOOLEAN, PRIMARY KEY (\`ID\`));`,
        (err) => {
          if (err) {
            this.logger.error(`[MYSQL] could not create table threads: ${String(err)}`);
            throw new Error("[MYSQL] could not create table threads");
          }

          this.connection.query(
            `CREATE TABLE IF NOT EXISTS \`${this.database}\`.\`channels\` (\`id\` VARCHAR(20) NOT NULL, \`server\` VARCHAR(20) NOT NULL, \`regex\` TINYTEXT, \`roles\` TEXT, \`tags\` TEXT);`,
            (err) => {
              if (err) {
                this.logger.error(`[MYSQL] could not create table channels: ${String(err)}`);
                throw new Error("[MYSQL] could not create table channels");
              }

              this.connection.query(
                `CREATE TABLE IF NOT EXISTS \`${this.database}\`.\`config\` (\`server\` VARCHAR(20) NOT NULL, \`cfg_id\` VARCHAR(20) NOT NULL, \`value\` VARCHAR(20) NOT NULL, PRIMARY KEY(\`server\`, \`cfg_id\`))`,
                (err) => {
                  if (err) {
                    this.logger.error(`[MYSQL] could not create table config: ${String(err)}`);
                    throw new Error("[MYSQL] could not create table config");
                  }
                  resolve();
                }
              );
            }
          );
        }
      );
    });
  }

  setConfigValue(guildID: string, key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.query("INSERT INTO config VALUES(?,?,?)", [guildID, key, value], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  deleteConfigValue(guildID: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.query(
        "DELETE FROM config WHERE server = ? AND cfg_id = ?",
        [guildID, key],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  }

  getConfigValue(guildID: string, key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.connection.query(
        "SELECT * FROM config WHERE server = ? AND cfg_id = ?",
        [guildID, key],
        (err, res: { server: string; cfg_id: string; value: string }[]) => {
          if (err) return reject(err);
          if (res?.[0]) return resolve(res[0]["value"]);
          return reject(new Error("NO ROW FOUND"));
        }
      );
    });
  }

  insertChannel(data: ChannelData): Promise<void> {
    return new Promise((resolve, reject) => {
      const { id, server, regex, roles, tags } = data;
      this.connection.query(
        "REPLACE INTO channels VALUES(?,?,?,?,?)",
        [id, server, regex, roles.join(","), tags.join(",")],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  }

  insertThread(id: string, dueArchive: number, server: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.query(
        "REPLACE INTO threads VALUES(?,?,?,true)",
        [id, server, dueArchive],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  }

  updateDueArchive(id: string, dueArchive: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.query(
        "UPDATE threads SET dueArchive = ? WHERE id = ?",
        [dueArchive, id],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  }

  /**
     * 
     *             returnArr.push( ...this.db.prepare("SELECT * FROM channels WHERE server = ?").all(guildID).map( item => {
                let rv: ChannelData = { id: item.id, server: item.server, regex: item?.regex, tags: item?.tags.split(","), roles: item?.roles.split(",") };
                return rv
            }) )
     * 
     * @param data 
     * @returns 
     */

  getChannels(server: string): Promise<ChannelData[]> {
    interface rawChannelData {
      id: string;
      server: string;
      regex?: string;
      roles?: string;
      tags?: string;
    }

    return new Promise((resolve, reject) => {
      const returnArr: ChannelData[] = [];
      this.connection.query(
        "SELECT * FROM channels WHERE server = ?",
        [server],
        (err, res: rawChannelData[]) => {
          if (err || !res) reject(err);

          for (const row of res)
            returnArr.push({
              id: row.id,
              server: row.server,
              regex: row.regex || "",
              tags: row.tags?.split(",") || [],
              roles: row.roles?.split(",") || [],
            });

          return resolve(returnArr);
        }
      );
    });
  }

  getThreads(server: string): Promise<ThreadData[]> {
    return new Promise((resolve, reject) => {
      this.connection.query(
        "SELECT * FROM threads WHERE server = ? AND watching = 1",
        [server],
        (err, res) => {
          if (err) reject(err);
          return resolve(res);
        }
      );
    });
  }

  deleteThread(threadID: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.query("DELETE FROM threads WHERE id = ?", [threadID], (err, res) => {
        if (err) reject(err);
        return resolve(res);
      });
    });
  }

  deleteChannel(channelID: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.query("DELETE FROM channels WHERE id = ?", [channelID], (err, res) => {
        if (err) reject(err);
        return resolve(res);
      });
    });
  }

  deleteGuild(server: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const promises = [];
      promises.push(this.connection.query("DELETE FROM channels WHERE server = ?", [server]));
      promises.push(this.connection.query("DELETE FROM threads WHERE server = ?", [server]));
      Promise.all(promises)
        .then(() => resolve())
        .catch(reject);
    });
  }

  unwatchThread(threadID: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.query(
        "UPDATE threads SET watching = 0 WHERE id = ?",
        [threadID],
        (err, res) => {
          if (err) reject(err);
          return resolve(res);
        }
      );
    });
  }

  getNumberOfThreads(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.connection.query("SELECT COUNT(*) FROM threads;", (err, res) => {
        if (err) reject(err);
        let count = res[0];
        if (count) count = Object.values(res[0])[0];
        else count = NaN;
        return resolve(count);
      });
    });
  }

  getNumberOfChannels(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.connection.query("SELECT COUNT(*) FROM channels;", (err, res) => {
        if (err) reject(err);
        let count = res[0];
        if (count) count = Object.values(res[0])[0];
        else count = NaN;
        return resolve(count);
      });
    });
  }

  backup(options: { path: string }): Promise<boolean> {
    return new Promise((resolve) => {
      // Create the directory if it doesn't exist
      if (!existsSync(options.path)) {
        mkdirSync(options.path, { recursive: true });
      }

      // Get the current date for the filename
      const date = new Date();
      const filename = `backup-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}.sql`;
      const filepath = join(options.path, filename);

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
  }

  createBackup(baseDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const backupPath = `${join(baseDir, getBackupName())}.sql`;

      // Use the safer spawn-based backup method
      this.backup({ path: baseDir })
        .then((success) => {
          if (success) {
            resolve(backupPath);
          } else {
            reject(new Error("Backup failed"));
          }
        })
        .catch(reject);
    });
  }

  /**
   * Get all threads that are being watched
   */
  getAllWatchedThreads(): Promise<ThreadData[]> {
    return new Promise((resolve, reject) => {
      this.connection.query(
        "SELECT id, server, dueArchive, watching FROM threads WHERE watching = 1",
        (err: Error | null, results: ThreadRow[]) => {
          if (err) {
            this.logger.error(`Error fetching watched threads: ${err}`);
            return reject(err);
          }

          const threads: ThreadData[] = results.map((row: ThreadRow) => ({
            id: row.id,
            server: row.server,
            dueArchive: row.dueArchive,
            watching: Boolean(row.watching),
          }));

          resolve(threads);
        }
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connection.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
