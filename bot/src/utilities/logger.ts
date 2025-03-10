import Log75, { LogLevel } from "log75";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { stripVTControlCharacters } from "util";
import { trackInitState } from "./debugUtils";
import { HexColorString } from "discord.js";

// Default styles for log types
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
const logDir = path.join(__dirname, "../../data");
const logFile = path.join(logDir, "thread-watcher.log");
const logFilePath = path.join(__dirname, "../../data/thread-watcher.log");

// Logger configuration
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

let configSettings: LoggerOptions;
let logLevel: number = LogLevel.Standard;
let loggerInitialized = false;

function isValidHexColour(value: string): value is HexColorString {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function getLogStyle(type: "error" | "success" | "info" | "warning" | "debug" | "trace") {
  const resolvedType = type === "debug" || type === "trace" ? "info" : type;

  let style;
  switch (resolvedType) {
    case "error":
      style = configSettings?.style?.error;
      break;
    case "success":
      style = configSettings?.style?.success;
      break;
    case "info":
      style = configSettings?.style?.info;
      break;
    case "warning":
      style = configSettings?.style?.warning;
      break;
    default:
      style = defaultStyles.info;
  }

  if (!style || !isValidHexColour(style.colour)) {
    style = Object.prototype.hasOwnProperty.call(defaultStyles, resolvedType)
      ? defaultStyles[resolvedType as keyof typeof defaultStyles]
      : defaultStyles.info;
  }

  return style;
}

function hexToAnsiColorFn(hexColor: string): (text: string) => string {
  const hex = hexColor.startsWith("#") ? hexColor.slice(1) : hexColor;
  const hexRedValue = parseInt(hex.substring(0, 2), 16);
  const hexGreenValue = parseInt(hex.substring(2, 4), 16);
  const hexBlueValue = parseInt(hex.substring(4, 6), 16);
  return (text: string) =>
    `\x1b[38;2;${hexRedValue};${hexGreenValue};${hexBlueValue}m${text}\x1b[0m`;
}

// Extended Log75 class with custom styling
export class Log76 extends Log75 {
  [key: string]: ((...args: string[]) => void) | unknown;

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

  error(s: string): void {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("error");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "ERROR", colorFn, console.error);
      if (configSettings?.logToFile) logToFile(`[ERROR] ${s}`);
    }
  }

  warn(s: string): void {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("warning");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "WARN", colorFn, console.warn);
      if (configSettings?.logToFile) logToFile(`[WARN] ${s}`);
    }
  }

  done(s: string): void {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("success");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "OK", colorFn, console.log);
      if (configSettings?.logToFile) logToFile(`[OK] ${s}`);
    }
  }

  info(s: string): void {
    if (LogLevel.Standard <= logLevel) {
      const style = getLogStyle("info");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "INFO", colorFn, console.info);
      if (configSettings?.logToFile) logToFile(`[INFO] ${s}`);
    }
  }

  debug(s: string): void {
    if (LogLevel.Debug <= logLevel) {
      const style = getLogStyle("debug");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "DEBUG", colorFn, console.debug);
      if (configSettings?.logToFile) logToFile(`[DEBUG] ${s}`);
    }
  }

  trace(s: string): void {
    if (LogLevel.Trace <= logLevel) {
      const style = getLogStyle("trace");
      const colorFn = hexToAnsiColorFn(style.colour);
      super.print(s, "TRACE", colorFn, console.trace);
      if (configSettings?.logToFile) {
        logToFile(`[TRACE] ${s}`);
        trackInitState(s);
      }
    }
  }
}

const loggerInstance = new Log76(LogLevel.Standard, { color: true });

export interface Logger {
  error: (s: string) => void;
  warn: (s: string) => void;
  done: (s: string) => void;
  info: (s: string) => void;
  debug: (s: string) => void;
  trace: (s: string) => void;
  logLevel?: number;
  instance?: Logger;
  [key: string]: unknown;
}

export const logger: Logger = loggerInstance as unknown as Logger;

export const initLogger = (options: LoggerOptions = {}): Logger => {
  if (loggerInitialized) {
    console.warn(`initLogger already initialized in process ${process.pid}`);
    return logger;
  }

  loggerInitialized = true;
  configSettings = options;

  // Set log level based on options
  const envLogLevel = options.logLevel || "standard";
  switch (envLogLevel.toLowerCase()) {
    case "trace":
      logLevel = LogLevel.Trace;
      break;
    case "debug":
      logLevel = LogLevel.Debug;
      break;
    case "standard":
    default:
      logLevel = LogLevel.Standard;
      break;
  }

  if (!options.silent) {
    console.info(`Initializing logger in process ${process.pid}`);
  }

  // Create a new logger instance with the configured log level
  const newLoggerInstance = new Log76(logLevel, {
    color: true,
    bold: options.logBold,
    inverted: options.logInverted,
  });

  const safeLoggerMethods = ["error", "warn", "done", "info", "debug", "trace"] as const;
  type LoggerMethod = (typeof safeLoggerMethods)[number];

  safeLoggerMethods.forEach((name: LoggerMethod) => {
    if (
      name === "error" ||
      name === "warn" ||
      name === "done" ||
      name === "info" ||
      name === "debug" ||
      name === "trace"
    ) {
      const method = newLoggerInstance[name as keyof Log76];
      if (
        Object.prototype.hasOwnProperty.call(newLoggerInstance, name) &&
        typeof method === "function"
      ) {
        (logger[name as keyof typeof logger] as unknown as (s: string) => void) = (
          method as (s: string) => void
        ).bind(newLoggerInstance);
      }
    }
  });

  Object.defineProperty(logger, "instance", {
    value: logger,
    writable: false,
  });

  logger.logLevel = logLevel;

  logger.debug(`Logger initialized with Log level set to ${envLogLevel} (${logLevel}).`);

  return logger;
};

export const ensureLogDirectoryExists = (): void => {
  const dir = path.dirname(logFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export const initLogFile = (): void => {
  ensureLogDirectoryExists();
  try {
    const stats = statSync(logFilePath);
    if (stats.isDirectory()) {
      writeFileSync(`${logFilePath}.old`, "");
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

export function logToFile(message: string): void {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${stripVTControlCharacters(message)}\n`;
  appendFileSync(logFile, logMessage, { encoding: "utf8" });
}
