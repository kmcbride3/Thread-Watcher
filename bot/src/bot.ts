import { Client, GatewayIntentBits, RateLimitData, Options, ShardingManager } from "discord.js";
import Log75, { LogLevel } from "log75";
import loadEvents from "./utilities/loadEvents";
import loadCommands from "./utilities/loadCommands";

import { DataBases, getDatabase } from "./utilities/database/DatabaseManager";
import { ThreadData } from "./interfaces/database";
import { red, green, yellow, blue } from "ansi-colors";
import cnf from "./utilities/cnf/index";
import UserSettings from "./utilities/userSettings";
import { handleRateLimit } from "./utilities/apiErrorHandler";
import { logToFile } from "./utilities/fileLogger";

const config = cnf();

const db = getDatabase(DataBases[config.database.type as keyof typeof DataBases], config);
db.createTables();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ],
  makeCache: Options.cacheWithLimits({
    // Disable caching for other managers
    MessageManager: 0,
    PresenceManager: 0,
    UserManager: 0,
    GuildMemberManager: 0,
  }),
});

class log76 extends Log75 {
  constructor(level: LogLevel, options: { color: boolean }) {
    super(level, options);
  }

  // Override print so that the shard id is only added if present and no "UNKNOWN" is shown.
  print(msg: string, type: string, color: (msg: string) => string, output: (msg: string) => void): string {
    // Use shard id if available, else empty string.
    const shardLabel = client.shard?.ids.length ? client.shard.ids.join(", ") : "";
    const prefix = shardLabel ? `[Shard ${shardLabel}] ` : "";
    const formattedMsg = `${prefix}${msg}`;
    output(formattedMsg);
    return formattedMsg;
  }

  async error(s: string) {
    this.print(s, "ERR", red, console.error);
    await logToFile(`ERROR: ${s}`);
  }

  async done(s: string) {
    this.print(s, "OK", green, console.log);
    await logToFile(`DONE: ${s}`);
  }

  async warn(s: string) {
    this.print(s, "WARN", yellow, console.warn);
    await logToFile(`WARN: ${s}`);
  }
  
  async info(s: string) {
    this.print(s, "INFO", blue, console.log);
    await logToFile(`INFO: ${s}`);
  }
}

const logger = new log76(LogLevel.Debug, { color: true });

// Update console overrides to use a consistent format, omitting the "CONSOLE" prefix.
const originalConsoleError = console.error;
console.error = (...args) => {
  logToFile(`ERROR: ${args.join(" ")}`);
  originalConsoleError(...args);
};
const originalConsoleLog = console.log;
console.log = (...args) => {
  logToFile(`LOG: ${args.join(" ")}`);
  originalConsoleLog(...args);
};
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  logToFile(`WARN: ${args.join(" ")}`);
  originalConsoleWarn(...args);
};

const commands = loadCommands();

client.on('shardDisconnect', (_event, shardId) => {
  logger.warn(`Shard ${shardId} disconnected. Attempting to respawn...`);
  client.shard?.respawnAll();
});

client.on('rateLimit', (info: RateLimitData) => {
  logger.warn(`Rate limit hit: ${JSON.stringify(info)}`);
  handleRateLimit(info.retryAfter, info.global).then(() => {
    logger.info(`Resuming operations after delay of ${info.retryAfter}ms`);
  });
});

client.on('error', (error) => {
  logger.error(`Client error: ${error.message}`);
});

const threads = new Map<string, ThreadData>();
const settings = new UserSettings(db);

client.once('ready', async () => {
  logger.info("Bot connected successfully to the designated server(s).");
});

client.login(config.tokens.discord).catch((err) => {
  logger.error(`Could not authorise bot. ${err.toString()}`);
  throw new Error(`Could not authorise bot. ${err.toString()}`);
});

// Load events using ShardingManager from index.ts
export function initBot(deps: { manager: ShardingManager }): void {
  loadEvents(client, { manager: deps.manager });
}

export { client, logger, commands, db, threads, config, settings };

process.on("uncaughtException", (err) => {
  logger.error(
    `[FATAL ERROR] shard ${client.shard?.ids[0]} encountered a fatal error. (dump below)`,
  );
  console.error(err);
  throw new Error(
    `[FATAL ERROR] shard ${client.shard?.ids[0]} encountered a fatal error. (dump below)`,
  );
});
