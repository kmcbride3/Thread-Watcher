import { ColorResolvable, Colors, EmojiIdentifierResolvable } from "discord.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { parse as j5Parse, stringify } from "json5";
import path from "path";
import { isValidConfigFile, isWritableConfigFile, sanitizeInput } from "../securityUtils";
import { validateValue } from "./defaults";

// Define config file paths directly to avoid circular dependencies
const CONFIG_FILES = [
  path.join(process.cwd(), "config.json5"),
  path.join(process.cwd(), "_config.json5"),
  path.join(process.cwd(), "config.json"),
];

// Use the safe config paths defined above
const P_J5 = CONFIG_FILES[0]; // config.json5
const P_FBJ5 = CONFIG_FILES[1]; // _config.json5
const P_TS = path.join(__dirname, "../../config.js");

interface DbOptions {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  dataLocation: string;
}

export interface BotStyle {
  color: ColorResolvable;
  emoji?: EmojiIdentifierResolvable;
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
  style?: {
    error?: BotStyle;
    success?: BotStyle;
    info?: BotStyle;
    warning?: BotStyle;
    debug?: BotStyle;
    trace?: BotStyle;
    log?: BotStyle;
  };
  owners: string[];
  devServer: string;
  devServerInvite: string;
  logWebhook?: string;
  logLevel: "Quiet" | "Standard" | "Debug" | "Trace";
  logToFile: boolean;
  logBold: boolean;
  logInverted: boolean;
  shardCount?: number | "auto";
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

  // Validate that we're writing to an allowed config file path
  if (isWritableConfigFile(P_J5)) {
    writeFileSync(P_J5, stringify(oldConf, null, 3));
  } else {
    console.error(`Cannot write to config file: ${P_J5}`);
    throw new Error("Cannot write to config file");
  }
}

function ensureFile() {
  // Use isValidConfigFile to check file existence
  const j5CnfExists = isValidConfigFile(P_J5) && existsSync(P_J5);
  const j5FallBackExists = isValidConfigFile(P_FBJ5) && existsSync(P_FBJ5);
  const tsCnfExists = existsSync(P_TS);

  if (j5CnfExists) return null;

  if (!j5CnfExists && !j5FallBackExists && !tsCnfExists) {
    console.error(
      'No config exists.\nCopy the contents of https://github.com/ffamilyfriendly/Thread-Watcher/blob/main/bot/_config.json5 into a file called "config.json5" in the bot folder.'
    );
    throw new Error("No config file found");
  }

  if (tsCnfExists) {
    console.info("Old config found! Trying to parse...");
    parse();
    return null;
  }

  if (j5FallBackExists) {
    console.log("Moving config file:\n_config.json5 -> config.json5");

    // Verify both source and destination are valid config files before renaming
    if (isValidConfigFile(P_FBJ5) && isWritableConfigFile(P_J5)) {
      renameSync(P_FBJ5, P_J5);
    } else {
      console.error("Cannot rename config file due to security restrictions");
      throw new Error("Cannot rename config file");
    }
    return null;
  }

  return undefined;
}

// Environment variable override functions with better sanitization
function overrideTokens(config: ConfigFile): ConfigFile["tokens"] {
  return {
    discord: process.env.DISCORD_TOKEN
      ? sanitizeInput(process.env.DISCORD_TOKEN)
      : config.tokens.discord || "",
    topgg: process.env.TOPGG_TOKEN
      ? sanitizeInput(process.env.TOPGG_TOKEN)
      : config.tokens.topgg || "",
  };
}

function overrideClientID(config: ConfigFile): string {
  return process.env.CLIENT_ID ? sanitizeInput(process.env.CLIENT_ID) : config.clientID || "";
}

function overrideDatabase(config: ConfigFile): ConfigFile["database"] {
  return {
    ...config.database,
    type: (process.env.DB_TYPE as "sqlite" | "mysql") || config.database.type || "sqlite",
    options: {
      user: process.env.DB_USER
        ? sanitizeInput(process.env.DB_USER)
        : config.database.options.user || "",
      password: process.env.DB_PASSWORD
        ? sanitizeInput(process.env.DB_PASSWORD)
        : config.database.options.password || "",
      host: process.env.DB_HOST
        ? sanitizeInput(process.env.DB_HOST)
        : config.database.options.host || "localhost",
      port: process.env.DB_PORT
        ? parseInt(sanitizeInput(process.env.DB_PORT), 10)
        : config.database.options.port || 3306,
      database: process.env.DB_NAME
        ? sanitizeInput(process.env.DB_NAME)
        : config.database.options.database || "threadwatcher",
      dataLocation: process.env.DB_DATA_LOCATION
        ? sanitizeInput(process.env.DB_DATA_LOCATION)
        : config.database.options.dataLocation || "./data",
    },
    backupInterval: process.env.DB_BACKUP_INTERVAL
      ? sanitizeInput(process.env.DB_BACKUP_INTERVAL)
      : config.database.backupInterval || "0 */6 * * *",
    backupAmount: process.env.DB_BACKUP_AMOUNT
      ? parseInt(sanitizeInput(process.env.DB_BACKUP_AMOUNT), 10)
      : config.database.backupAmount || 10,
    backupProvider:
      (process.env.DB_BACKUP_PROVIDER as "none" | "discord") ||
      config.database.backupProvider ||
      "none",
  };
}

function overrideStatsServer(config: ConfigFile): ConfigFile["statsServer"] {
  return {
    enabled: process.env.STATS_SERVER_ENABLED === "true" || config.statsServer.enabled || false,
    port: process.env.STATS_SERVER_PORT
      ? parseInt(process.env.STATS_SERVER_PORT, 10)
      : config.statsServer.port || 3000,
  };
}

function overrideStye(config: ConfigFile): ConfigFile["style"] {
  return {
    ...config.style,
    error: {
      color:
        (process.env.STYLE_ERROR_COLOR as ColorResolvable) ||
        config.style?.error?.color ||
        Colors.Red,
      emoji: process.env.STYLE_ERROR_EMOJI || config.style?.error?.emoji || undefined,
    },
    success: {
      color:
        (process.env.STYLE_SUCCESS_COLOR as ColorResolvable) ||
        config.style?.success?.color ||
        Colors.Green,
      emoji: process.env.STYLE_SUCCESS_EMOJI || config.style?.success?.emoji || undefined,
    },
    info: {
      color:
        (process.env.STYLE_INFO_COLOR as ColorResolvable) ||
        config.style?.info?.color ||
        Colors.Blue,
      emoji: process.env.STYLE_INFO_EMOJI || config.style?.info?.emoji || undefined,
    },
    warning: {
      color:
        (process.env.STYLE_WARNING_COLOR as ColorResolvable) ||
        config.style?.warning?.color ||
        Colors.Yellow,
      emoji: process.env.STYLE_WARNING_EMOJI || config.style?.warning?.emoji || undefined,
    },
    debug: {
      color:
        (process.env.STYLE_DEBUG_COLOR as ColorResolvable) ||
        config.style?.debug?.color ||
        Colors.Orange,
      emoji: process.env.STYLE_DEBUG_EMOJI || config.style?.debug?.emoji || undefined,
    },
    trace: {
      color:
        (process.env.STYLE_TRACE_COLOR as ColorResolvable) ||
        config.style?.trace?.color ||
        Colors.Grey,
      emoji: process.env.STYLE_TRACE_EMOJI || config.style?.trace?.emoji || undefined,
    },
    log: {
      color:
        (process.env.STYLE_LOG_COLOR as ColorResolvable) ||
        config.style?.log?.color ||
        Colors.White,
      emoji: process.env.STYLE_LOG_EMOJI || config.style?.log?.emoji || undefined,
    },
  };
}

function overrideMisc(config: ConfigFile): Partial<ConfigFile> {
  return {
    devServer: process.env.DEV_SERVER || config.devServer || "",
    devServerInvite: process.env.DEV_SERVER_INVITE || config.devServerInvite || "",
    logWebhook: process.env.LOG_WEBHOOK || config.logWebhook || "",
    logLevel:
      (process.env.LOG_LEVEL as "Quiet" | "Standard" | "Debug" | "Trace") ||
      config.logLevel ||
      "Standard",
    logToFile: process.env.LOG_TO_FILE === "true" || config.logToFile || false,
    logBold: process.env.LOG_BOLD === "true" || config.logBold || false,
    logInverted: process.env.LOG_INVERTED === "true" || config.logInverted || false,
    shardCount:
      process.env.SHARD_COUNT === "auto"
        ? "auto"
        : process.env.SHARD_COUNT
          ? parseInt(process.env.SHARD_COUNT, 10)
          : config.shardCount || 1,
  };
}

function overrideWithEnv(config: ConfigFile): ConfigFile {
  return {
    ...config,
    tokens: overrideTokens(config),
    clientID: overrideClientID(config),
    database: overrideDatabase(config),
    statsServer: overrideStatsServer(config),
    style: overrideStye(config),
    ...overrideMisc(config),
  };
}

export function getConfig(): ConfigFile {
  ensureFile();
  const reviver = (key: string, value: unknown) =>
    validateValue(key, value as string | boolean | null | undefined);

  try {
    // Verify we're reading from a valid config file path
    if (!isValidConfigFile(P_J5)) {
      throw new Error(`Invalid config file path: ${P_J5}`);
    }

    const configText = readFileSync(P_J5, "utf-8");
    const config = j5Parse(configText, reviver) as ConfigFile;
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
    throw new Error("Error reading the config file");
  }
}
