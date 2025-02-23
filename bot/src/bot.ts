import { Client, GatewayIntentBits, RateLimitData, Options } from "discord.js";
import Log75, { LogLevel } from "log75";
import loadEvents from "./utilities/loadEvents";
import loadCommands from "./utilities/loadCommands";
import { DataBases, getDatabase } from "./utilities/database/DatabaseManager";
import { ThreadData } from "./interfaces/database";
import { red, green, yellow } from "ansi-colors";
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
  async error(s: string) {
    super.print(s, `${client.shard?.ids[0]} ERR`, red, console.error);
    await logToFile(`ERROR: ${s}`);
  }

  async done(s: string) {
    super.print(s, `${client.shard?.ids[0]} OK`, green, console.log);
    await logToFile(`DONE: ${s}`);
  }

  async warn(s: string) {
    super.print(s, `${client.shard?.ids[0]} WARN`, yellow, console.warn);
    await logToFile(`WARN: ${s}`);
  }
}

const logger = new log76(LogLevel.Debug, { color: true });

const originalConsoleError = console.error;
console.error = (...args) => {
  logToFile(`CONSOLE ERROR: ${args.join(' ')}`);
  originalConsoleError(...args);
};

const originalConsoleLog = console.log;
console.log = (...args) => {
  logToFile(`CONSOLE LOG: ${args.join(' ')}`);
  originalConsoleLog(...args);
};

const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  logToFile(`CONSOLE WARN: ${args.join(' ')}`);
  originalConsoleWarn(...args);
};

loadEvents(client);
const commands = loadCommands();

client.on('shardDisconnect', (_event, shardId) => {
  logger.warn(`Shard ${shardId} disconnected. Attempting to respawn...`);
  client.shard?.respawnAll();
});

client.on('rateLimit', (info: RateLimitData) => {
  logger.warn(`Rate limit hit: ${JSON.stringify(info)}`);
  handleRateLimit(info.retryAfter, info.global).then(() => {
    logger.info(`Resuming operations after rate limit delay of ${info.retryAfter}ms`);
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
