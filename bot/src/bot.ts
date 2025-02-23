import { Client, GatewayIntentBits, RateLimitData, Options, ShardingManager } from "discord.js";
import Log75 from "log75";
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
  static LogLevel = {
    Quiet: 0,
    Error: 1,
    Warn: 2,
    Standard: 3,
    Debug: 4,
    Trace: 5
  };

  constructor(level: number, options: { color: boolean }) {
    super(level, options);
  }

  // Override print so that the shard id is only added if present and no "UNKNOWN" is shown.
  print(msg: string, type: string, color: (msg: string) => string, output: (msg: string) => void): string {
    // Use shard id if available, else empty string.
    const shardLabel = client.shard?.ids.length ? `Shard ${client.shard.ids.join(", ")}: ` : "";
    const formattedMsg = `[${color(`${type}`)}] ${shardLabel}${msg}`;
    output(formattedMsg);
    return formattedMsg;
  }

  async error(s: string) {
    if (logLevel >= log76.LogLevel.Error) {
      this.print(s, "ERROR", red, originalConsoleError);
      if (config.logToFile) await logToFile(`[ERROR] ${s}`);
    }
  }

  async done(s: string) {
    if (logLevel >= log76.LogLevel.Standard) {
      this.print(s, "OK", green, originalConsoleLog);
      if (config.logToFile) await logToFile(`[OK] ${s}`);
    }
  }

  async warn(s: string) {
    if (logLevel >= log76.LogLevel.Warn) {
      this.print(s, "WARN", yellow, originalConsoleWarn);
      if (config.logToFile) await logToFile(`[WARN] ${s}`);
    }
  }
  
  async info(s: string) {
    if (logLevel >= log76.LogLevel.Standard) {
      this.print(s, "INFO", blue, originalConsoleInfo);
      if (config.logToFile) await logToFile(`[INFO] ${s}`);
    }
  }

  async debug(s: string) {
    if (logLevel >= log76.LogLevel.Debug) {
      this.print(s, "DEBUG", blue, originalConsoleLog);
      if (config.logToFile) await logToFile(`[DEBUG] ${s}`);
    }
  }

  async trace(s: string) {
    this.print(s, "TRACE", blue, originalConsoleTrace);
  }
}

// Set log level from config
const logLevel = log76.LogLevel[config.logLevel.toUpperCase() as keyof typeof log76.LogLevel] || log76.LogLevel.Standard;
const logger = new log76(logLevel, { color: true });

const originalConsoleError = console.error.bind(console)
const originalConsoleLog = console.log.bind(console)
const originalConsoleWarn = console.warn.bind(console)
const originalConsoleInfo = console.info.bind(console)
const originalConsoleTrace = console.trace.bind(console)

// Update console overrides to use a consistent format, omitting the "CONSOLE" prefix.
console.error = (...args) => {
  logger.error(args.join(" "));
};
console.log = (...args) => {
  logger.info(args.join(" "));
};
console.warn = (...args) => {
  logger.warn(args.join(" "));
};
console.info = (...args) => {
  logger.info(args.join(" "));
};
console.trace = (...args) => {
  logger.trace(args.join(" "));
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

client.on('error', (error: Error) => {
  logger.error(`Client error: ${error.message}`);
});

const threads = new Map<string, ThreadData>();
const settings = new UserSettings(db);

client.once('ready', async () => {
  if (client.shard) {
    logger.done("Bot connected successfully to the designated server(s).");
  }
});

client.login(config.tokens.discord).catch((err: Error) => {
  logger.error(`Could not authorise bot. ${err.toString()}`);
  process.exit(1);
});

// Load events using ShardingManager from index.ts
export function initBot(deps: { manager: ShardingManager }): void {
  loadEvents(client, { manager: deps.manager });
}

export { client, logger, commands, db, threads, config, settings };

let shuttingDown = false;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  shuttingDown = true;
  logger.info("Shutdown signal received, cleaning up...");
  // Optionally perform cleanup here (e.g., closing DB connections)
  process.exit(0);
}

process.on("uncaughtException", (err) => {
  if (shuttingDown) {
    // Suppress logging errors during shutdown
    process.exit(0);
  } else {
    logger.error(
      `[FATAL ERROR] shard ${client.shard?.ids[0]} encountered a fatal error. (dump below)`
    );
    logger.error(err.toString());
    process.exit(1);
  }
});
