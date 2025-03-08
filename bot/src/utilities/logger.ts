import Log75, { LogLevel } from "log75";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { stripVTControlCharacters } from "util";
import { trackInitState } from "./debugUtils";
import { HexColorString } from "discord.js";

const defaultStyles: Record<
  "error" | "success" | "info" | "warning" | "debug" | "trace",
  { colour: string }
> = {
  error: { colour: "#FF0000" },
  success: { colour: "#00FF00" },
  info: { colour: "#0000FF" },
  warning: { colour: "#FFA500" },
  debug: { colour: "#808080" },
  trace: { colour: "#808080" },
};

function isValidHexColour(value: string): value is HexColorString {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function getLogStyle(type: "error" | "success" | "info" | "warning" | "debug" | "trace") {
  const resolvedType = type;
  let style;
  switch (resolvedType) {
    case "error":
      style = configSettings?.style?.error;
      if (!style || !isValidHexColour(style.colour)) {
        style = defaultStyles.error;
      }
      break;
    case "success":
      style = configSettings?.style?.success;
      if (!style || !isValidHexColour(style.colour)) {
        style = defaultStyles.success;
      }
      break;
    case "info":
      style = configSettings?.style?.info;
      if (!style || !isValidHexColour(style.colour)) {
        style = defaultStyles.info;
      }
      break;
    case "warning":
      style = configSettings?.style?.warning;
      if (!style || !isValidHexColour(style.colour)) {
        style = defaultStyles.warning;
      }
      break;
    default:
      style = defaultStyles.info;
      break;
  }
  return style;
}

function hexToAnsiColorFn(hexColor: string): (text: string) => string {
  const hex = hexColor.startsWith("#") ? hexColor.slice(1) : hexColor;
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const logDir = path.join(__dirname, "../../data");
const logFile = path.join(logDir, "thread-watcher.log");
const logFilePath = path.join(__dirname, "../../data/thread-watcher.log");

let configSettings: LoggerOptions;

export class Log76 extends Log75 {
  constructor(
    level: number,
    options: {
      color: boolean;
      bold?: boolean;
      inverted?: boolean;
      maxTypeLength?: 5;
    }
  ) {
    super(level ?? 1, options);
  }

  async error(s: string) {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("error");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "ERROR", colorFn, console.error);
      if (configSettings?.logToFile) await logToFile(`[ERROR] ${s}`);
    }
  }

  async warn(s: string) {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("warning");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "WARN", colorFn, console.warn);
      if (configSettings?.logToFile) await logToFile(`[WARN] ${s}`);
    }
  }

  async done(s: string) {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("success");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "OK", colorFn, console.log);
      if (configSettings?.logToFile) await logToFile(`[OK] ${s}`);
    }
  }

  async info(s: string) {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("info");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "INFO", colorFn, console.info);
      if (configSettings?.logToFile) await logToFile(`[INFO] ${s}`);
    }
  }

  async debug(s: string) {
    if (LogLevel.Debug <= logLevel) {
      const style = getLogStyle("debug");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "DEBUG", colorFn, console.debug);
      if (configSettings?.logToFile) await logToFile(`[DEBUG] ${s}`);
    }
  }

  async trace(s: string) {
    if (LogLevel.Trace <= logLevel) {
      const style = getLogStyle("trace");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "TRACE", colorFn, console.trace);
      if (configSettings?.logToFile) {
        await logToFile(`[TRACE] ${s}`);
        trackInitState(s);
      }
    }
  }
}

let logLevel: number;
export let logger: Log76;

let loggerInitialized = false;

export interface LoggerOptions {
  logLevel?: string;
  logBold?: boolean;
  logInverted?: boolean;
  logToFile?: boolean;
  silent?: boolean;
  style?: Partial<
    Record<"error" | "success" | "info" | "warning" | "debug" | "trace", { colour: HexColorString }>
  >;
}

export const initLogger = (options: LoggerOptions = {}): void => {
  if (loggerInitialized) {
    console.warn(`initLogger already initialized in process ${process.pid}`);
    return;
  }
  loggerInitialized = true;

  if (!options.silent) {
    console.info(`Initializing logger in process ${process.pid}`);
  }
  configSettings = options;
  const envLogLevel = process.env.LOG_LEVEL || "Standard";
  logLevel = LogLevel[envLogLevel as keyof typeof LogLevel] ?? LogLevel.Standard;
  logger = new Log76(logLevel, {
    color: true,
    bold: options.logBold ?? false,
    inverted: options.logInverted ?? false,
    maxTypeLength: 5,
  });
  logger.debug(`Logger initialized with Log level set to ${envLogLevel} (${logLevel}).`);
};

export const ensureLogDirectoryExists = () => {
  const dir = path.dirname(logFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export const initLogFile = () => {
  ensureLogDirectoryExists();
  try {
    const stats = statSync(logFilePath);
    if (stats.isDirectory()) {
      writeFileSync(logFilePath + ".old", "");
      writeFileSync(logFilePath, "", { mode: 0o666 });
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      writeFileSync(logFilePath, "", { mode: 0o666 });
    } else {
      throw e;
    }
  }
};

if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

export async function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${stripVTControlCharacters(message)}\n`;
  appendFileSync(logFile, logMessage, { encoding: "utf8" });
}
