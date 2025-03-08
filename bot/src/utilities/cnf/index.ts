import { stringify, parse as j5Parse } from "json5";
import { join } from "path";
import { existsSync, renameSync, readFileSync, writeFileSync } from "fs";
import { validateValue } from "./defaults";

const P_J5 = join(__dirname, "../../../config.json5");
const P_FBJ5 = join(__dirname, "../../../_config.json5");
const P_TS = join(__dirname, "../../config.js");

interface DbOptions {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  dataLocation: string;
}

interface BotStyle {
  colour: string;
  emoji: string;
}

export interface ConfigFile {
  tokens: { discord: string; topgg: string };
  clientID: string;
  database: {
    type: "sqlite" | "mysql";
    options: DbOptions;
    backupInterval: string;
    backupAmount: number;
    backupProvider: "none" | "discord";
  };
  statsServer: { enabled: boolean; port: number };
  style: {
    error: BotStyle;
    success: BotStyle;
    info: BotStyle;
    warning: BotStyle;
  };
  owners: string[];
  devServer: string;
  devServerInvite: string;
  logWebhook?: string;
  logLevel: "Quiet" | "Standard" | "Debug" | "Trace";
  logToFile: boolean;
  logBold: boolean;
  logInverted: boolean;
}

async function parse(): Promise<void> {
  const { default: deprecatedFile } = await import(P_TS);
  if (!deprecatedFile) {
    console.info("Could not find old config");
    return;
  }
  const oldConf = deprecatedFile as ConfigFile;

  if (!oldConf.database.type) {
    console.warn(
      "Database type has been set to 'sqlite' by default. If you previously used 'mysql', please update the 'database.type' field in the configuration file to 'mysql' and provide the necessary connection details."
    );
  }
  oldConf.database.options.dataLocation = "./";
  writeFileSync(P_J5, stringify(oldConf, null, 3));
}

function ensureFile() {
  const j5CnfExists = existsSync(P_J5);
  const j5FallBackExists = existsSync(P_FBJ5);
  const tsCnfExists = existsSync(P_TS);

  if (j5CnfExists) return null;

  if (!j5CnfExists && !j5FallBackExists && !tsCnfExists) {
    console.error(
      'No config exists.\nCopy the contents of https://github.com/ffamilyfriendly/Thread-Watcher/blob/main/bot/_config.json5 into a file called "config.json5" in the bot folder.'
    );
    process.exit(1);
  }

  if (tsCnfExists) {
    console.info("Old config found! Trying to parse...");
    parse();
    return null;
  }

  if (j5FallBackExists) {
    console.log("Moving config file:\n_config.json5 -> config.json5");
    renameSync(P_FBJ5, P_J5);
    return null;
  }
}

function overrideWithEnv(config: ConfigFile): ConfigFile {
  const envOverrides = {
    tokens: {
      discord: process.env.DISCORD_TOKEN,
      topgg: process.env.TOPGG_TOKEN,
    },
    clientID: process.env.CLIENT_ID,
    database: {
      type: process.env.DB_TYPE as "sqlite" | "mysql",
      options: {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
        database: process.env.DB_NAME,
        dataLocation: process.env.DB_DATA_LOCATION,
      },
      backupInterval: process.env.DB_BACKUP_INTERVAL,
      backupAmount: process.env.DB_BACKUP_AMOUNT
        ? parseInt(process.env.DB_BACKUP_AMOUNT, 10)
        : undefined,
      backupProvider: process.env.DB_BACKUP_PROVIDER as "none" | "discord",
    },
    statsServer: {
      enabled: process.env.STATS_SERVER_ENABLED === "true",
      port: process.env.STATS_SERVER_PORT ? parseInt(process.env.STATS_SERVER_PORT, 10) : undefined,
    },
    devServer: process.env.DEV_SERVER,
    devServerInvite: process.env.DEV_SERVER_INVITE,
    logWebhook: process.env.LOG_WEBHOOK,
    logLevel: process.env.LOG_LEVEL as "Quiet" | "Standard" | "Debug" | "Trace",
    logToFile: process.env.LOG_TO_FILE === "true",
    logBold: process.env.LOG_BOLD === "true",
    logInverted: process.env.LOG_INVERTED === "true",
  };

  return {
    ...config,
    tokens: {
      discord: envOverrides.tokens.discord || config.tokens.discord || "",
      topgg: envOverrides.tokens.topgg || config.tokens.topgg || "",
    },
    clientID: envOverrides.clientID || config.clientID || "",
    database: {
      ...config.database,
      type: envOverrides.database.type || config.database.type || "sqlite",
      options: {
        user: envOverrides.database.options.user || config.database.options.user || "",
        password: envOverrides.database.options.password || config.database.options.password || "",
        host: envOverrides.database.options.host || config.database.options.host || "localhost",
        port:
          envOverrides.database.options.port !== undefined
            ? envOverrides.database.options.port
            : config.database.options.port || 3306,
        database:
          envOverrides.database.options.database ||
          config.database.options.database ||
          "threadwatcher",
        dataLocation:
          envOverrides.database.options.dataLocation ||
          config.database.options.dataLocation ||
          "./data",
      },
      backupInterval:
        envOverrides.database.backupInterval || config.database.backupInterval || "0 */6 * * *",
      backupAmount:
        envOverrides.database.backupAmount !== undefined
          ? envOverrides.database.backupAmount
          : config.database.backupAmount || 10,
      backupProvider:
        envOverrides.database.backupProvider || config.database.backupProvider || "none",
    },
    statsServer: {
      enabled:
        envOverrides.statsServer.enabled !== undefined
          ? envOverrides.statsServer.enabled
          : config.statsServer.enabled || false,
      port:
        envOverrides.statsServer.port !== undefined
          ? envOverrides.statsServer.port
          : config.statsServer.port || 3000,
    },
    devServer: envOverrides.devServer || config.devServer || "",
    devServerInvite: envOverrides.devServerInvite || config.devServerInvite || "",
    logWebhook: envOverrides.logWebhook || config.logWebhook || "",
    logLevel: envOverrides.logLevel || config.logLevel || "Standard",
    logToFile:
      envOverrides.logToFile !== undefined ? envOverrides.logToFile : config.logToFile || false,
    logBold: envOverrides.logBold !== undefined ? envOverrides.logBold : config.logBold || false,
    logInverted:
      envOverrides.logInverted !== undefined
        ? envOverrides.logInverted
        : config.logInverted || false,
  };
}

export function getConfig(): ConfigFile {
  ensureFile();
  const reviver = (key: string, value: unknown) =>
    validateValue(key, value as string | boolean | null | undefined);
  try {
    const config = j5Parse(readFileSync(P_J5, "utf-8"), reviver) as ConfigFile;
    const finalConfig = overrideWithEnv(config);

    // Convert logLevel to proper case
    finalConfig.logLevel = (finalConfig.logLevel.charAt(0).toUpperCase() +
      finalConfig.logLevel.slice(1).toLowerCase()) as "Quiet" | "Standard" | "Debug" | "Trace";

    if (
      !finalConfig.logLevel ||
      !["Quiet", "Standard", "Debug", "Trace"].includes(finalConfig.logLevel)
    ) {
      finalConfig.logLevel = "Standard";
    }

    return finalConfig;
  } catch (error) {
    console.error(`Error reading the config file: ${error}`);
    process.exit(1);
  }
}
