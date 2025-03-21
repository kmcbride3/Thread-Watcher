import { ColorResolvable, Colors, resolveColor } from "discord.js";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import Log75, { LogLevel } from "log75";
import path from "path";
import { stripVTControlCharacters } from "util";
import { getProcessContext } from "./processState";

// Keep track of logger module load to avoid duplicate startup messages
let loggerModuleLoaded = false;
let startupMessageShown = false;

// More controlled initialization message - only show once per process
if (!loggerModuleLoaded) {
  // Check if we're a shard to avoid duplicate messages across processes
  const isShard = process.argv.includes("--is-shard") || process.env.IS_SHARD === "true";

  // Only show the startup message for the main process at debug level
  if (!isShard) {
    console.debug(`Loading Thread-Watcher logger (PID: ${process.pid})`);
  }

  // Always mark module as loaded regardless of process type
  loggerModuleLoaded = true;
}

// Define status types as a constant array to serve as a single source of truth
export const STATUS_TYPES = [
  "error",
  "warning",
  "warn",
  "success",
  "done",
  "info",
  "debug",
  "trace",
  "log",
] as const;

// Define the type from the array to ensure they stay in sync
export type StatusType = (typeof STATUS_TYPES)[number];

// Create a proper type guard function to validate StatusType values
export function isValidStatusType(value: string): value is StatusType {
  return STATUS_TYPES.includes(value as StatusType);
}

// File paths for logging - defined once
const logDir = path.join(__dirname, "../../data/logs");
const logFile = path.join(logDir, "thread-watcher.log");

// Logger configuration
export interface LoggerOptions {
  logLevel?: string;
  logBold?: boolean;
  logInverted?: boolean;
  logToFile?: boolean;
  silent?: boolean;
  style?: {
    error?: { color: ColorResolvable };
    success?: { color: ColorResolvable };
    info?: { color: ColorResolvable };
    warning?: { color: ColorResolvable };
    debug?: { color: ColorResolvable };
    trace?: { color: ColorResolvable };
    log?: { color: ColorResolvable };
  };
}

// Module-level variables
let configSettings: LoggerOptions = {};
let logLevel: number = LogLevel.Standard;
let loggerInitialized = false;

export function isValidColorResolvable(value: unknown): boolean {
  if (value === null || value === undefined) return false;

  try {
    // Use Discord.js's built-in color resolver, which handles multiple formats
    resolveColor(value as ColorResolvable);
    return true;
  } catch {
    return false;
  }
}

// Define the complete method config structure for type safety
interface LogMethodConfig {
  minLevel: number;
  consoleMethod: ConsoleMethod;
  label: string;
  defaultColor: ColorResolvable; // Added default color property
  fallbackLevel?: StatusType;
}

// Use a Map instead of an object to avoid prototype pollution
const LOG_METHOD_CONFIG = new Map<StatusType, LogMethodConfig>([
  [
    "error",
    {
      minLevel: LogLevel.Quiet,
      consoleMethod: console.error,
      label: "ERROR",
      defaultColor: Colors.Red,
    },
  ],
  [
    "warning",
    {
      minLevel: LogLevel.Quiet,
      consoleMethod: console.warn,
      label: "WARN",
      defaultColor: Colors.Yellow,
    },
  ],
  [
    "warn",
    {
      minLevel: LogLevel.Quiet,
      consoleMethod: console.warn,
      label: "WARN",
      defaultColor: Colors.Yellow,
      fallbackLevel: "warning",
    },
  ],
  [
    "success",
    {
      minLevel: LogLevel.Standard,
      consoleMethod: console.info,
      label: "OK",
      defaultColor: Colors.Green,
    },
  ],
  [
    "done",
    {
      minLevel: LogLevel.Standard,
      consoleMethod: console.log,
      label: "OK",
      defaultColor: Colors.Green,
      fallbackLevel: "success",
    },
  ],
  [
    "info",
    {
      minLevel: LogLevel.Standard,
      consoleMethod: console.info,
      label: "INFO",
      defaultColor: Colors.Blue,
    },
  ],
  [
    "debug",
    {
      minLevel: LogLevel.Debug,
      consoleMethod: console.debug,
      label: "DEBUG",
      defaultColor: Colors.Purple,
    },
  ],
  [
    "trace",
    {
      minLevel: LogLevel.Trace,
      consoleMethod: console.trace,
      label: "TRACE",
      defaultColor: Colors.Grey,
    },
  ],
  [
    "log",
    {
      minLevel: LogLevel.Standard,
      consoleMethod: console.log,
      label: "LOG",
      defaultColor: Colors.White,
    },
  ],
]);

// Improved getLogStyle function with better type safety
function getLogStyle(type: StatusType) {
  let style;

  // Try to get style from config settings
  if (configSettings?.style) {
    switch (type) {
      case "error":
        style = configSettings.style.error;
        break;
      case "success":
        style = configSettings.style.success;
        break;
      case "info":
        style = configSettings.style.info;
        break;
      case "warning":
        style = configSettings.style.warning;
        break;
      case "debug":
        style = configSettings.style.debug;
        break;
      case "trace":
        style = configSettings.style.trace;
        break;
      case "log":
        style = configSettings.style.log;
        break;
    }
  }

  // Validate style and fall back to defaults if needed
  if (!style || !style.color || !isValidColorResolvable(style.color)) {
    // Get default color from LOG_METHOD_CONFIG with safe fallback
    const config = LOG_METHOD_CONFIG.get(type) ||
      LOG_METHOD_CONFIG.get("info") || { defaultColor: Colors.White }; // Provide inline fallback if both lookups fail
    style = { color: config.defaultColor };
  }

  return style;
}

// Convert various Discord.js color formats to an ANSI color function for terminal output
function createAnsiColorFunction(colorValue: ColorResolvable): (text: string) => string {
  try {
    // Use Discord.js's built-in color resolver which handles all valid formats
    // (hex strings, RGB arrays, color names, integers)
    const colorInt = resolveColor(colorValue);

    // Extract RGB components from the resolved integer
    const r = (colorInt >> 16) & 0xff;
    const g = (colorInt >> 8) & 0xff;
    const b = colorInt & 0xff;

    // Return a function that applies these RGB values as ANSI color codes
    return (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  } catch {
    // Fallback to light gray on error
    console.error(`Invalid color format: ${String(colorValue)}`);
    return (text: string) => `\x1b[37m${text}\x1b[0m`;
  }
}

function formatWithContext(message: string, context?: string): string {
  if (context) {
    // Ensure consistent spacing after the context bracket
    return `[${context.toUpperCase()}] ${message}`;
  }
  return message;
}

// Define the log method signature for consistency
type LogMethod = (message: string, context?: string, customLogFile?: string) => void;

// Use TypeScript's built-in Console method type instead of our custom type
type ConsoleMethod =
  | typeof console.log
  | typeof console.error
  | typeof console.warn
  | typeof console.debug
  | typeof console.trace
  | typeof console.info;

// Define a type-safe list of methods to ensure we don't add unexpected ones
const VALID_LOG_METHODS: StatusType[] = [
  "error",
  "warning",
  "warn",
  "success",
  "done",
  "info",
  "debug",
  "trace",
  "log",
];

/**
 * Core fallback logging function shared by safeLog and Log76 methods
 * This serves as the "universal" logging fallback when normal methods can't be used
 */
function fallbackConsoleLog(
  level: StatusType,
  message: string,
  context?: string,
  includeTimestamp = true
): void {
  // Get config with safe fallbacks
  const config = LOG_METHOD_CONFIG.get(level) || LOG_METHOD_CONFIG.get("info");
  const label = config?.label || level.toUpperCase();
  const consoleMethod: ConsoleMethod = config?.consoleMethod || console.log;

  // Format message with context
  let effectiveContext = context;
  try {
    if (!effectiveContext) {
      effectiveContext = getProcessContext();
    }
  } catch {
    // If processState isn't available yet, continue without default context
  }

  const formattedMessage = effectiveContext
    ? `[${effectiveContext.toUpperCase()}] ${message}`
    : message;

  // Add timestamp if requested
  const logMessage = includeTimestamp
    ? `${new Date().toISOString()} [${label}] ${formattedMessage}`
    : `[${label}] ${formattedMessage}`;

  // Output to console
  consoleMethod(logMessage);

  // Special handling for errors - always write to file
  if (level === "error" || level === "warning") {
    try {
      if (existsSync(logDir)) {
        const logFileMessage = stripVTControlCharacters(
          `${new Date().toISOString()} [${label}] ${formattedMessage}\n`
        );
        appendFileSync(logFile, logFileMessage);
      }
    } catch {
      // Silent fail when file logging fails
    }
  }
}

// Modified Log76 class with even safer implementation
export class Log76 extends Log75 {
  // Explicitly define the fields for all logger methods
  error!: LogMethod;
  warning!: LogMethod;
  warn!: LogMethod;
  success!: LogMethod;
  done!: LogMethod;
  info!: LogMethod;
  debug!: LogMethod;
  trace!: LogMethod;
  log!: LogMethod;

  [key: string]: LogMethod | unknown;

  // Add logLevel as a direct property of Log76
  logLevel: number;

  // Add instance property used for backward compatibility
  instance?: Log76;

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
    this.logLevel = level; // Store the log level as a class property

    // Initialize all log methods using the generic logger function
    this._initializeMethods();
  }

  /**
   * Initialize all logging methods using the generic log function
   * This ensures consistent behavior across all log types
   */
  private _initializeMethods(): void {
    // Use the shared configuration - iterate through validated list
    for (const methodName of VALID_LOG_METHODS) {
      const config = LOG_METHOD_CONFIG.get(methodName);
      if (config) {
        // Use type-specific assignments instead of dynamic property assignment
        // This avoids the object injection sink
        this._assignLogMethod(methodName, config);
      }
    }
  }

  /**
   * Safely assign a log method to the appropriate property based on method name
   * This avoids using bracket notation directly for property assignment
   */
  private _assignLogMethod(methodName: StatusType, config: LogMethodConfig): void {
    const logMethod = (message: string, context?: string, customLog?: string): void => {
      try {
        // First try the normal method if appropriate log level
        if (config.minLevel <= this.logLevel) {
          this.printMsg(methodName, message, context, customLog);
        }
      } catch {
        // If regular logging fails, use the shared fallback
        fallbackConsoleLog(methodName, message, context, false);
      }
    };

    // Use explicit property assignments instead of dynamic property access
    switch (methodName) {
      case "error":
        this.error = logMethod;
        break;
      case "warning":
        this.warning = logMethod;
        break;
      case "warn":
        this.warn = logMethod;
        break;
      case "success":
        this.success = logMethod;
        break;
      case "done":
        this.done = logMethod;
        break;
      case "info":
        this.info = logMethod;
        break;
      case "debug":
        this.debug = logMethod;
        break;
      case "trace":
        this.trace = logMethod;
        break;
      case "log":
        this.log = logMethod;
        break;
    }
  }

  /**
   * Core printing method that handles all log types
   */
  printMsg(status: StatusType, message: string, context?: string, customLog?: string): void {
    // Validate status and get config safely
    const safeStatus = isValidStatusType(status) ? status : "info";
    // Get config with safe fallbacks without using non-null assertion
    const infoConfig = LOG_METHOD_CONFIG.get("info");
    const config =
      LOG_METHOD_CONFIG.get(safeStatus) ||
      (infoConfig
        ? infoConfig
        : {
            minLevel: LogLevel.Standard,
            consoleMethod: console.info,
            label: "INFO",
          });

    // Use process context when none is provided
    let effectiveContext = context;
    if (!effectiveContext) {
      try {
        effectiveContext = getProcessContext();
      } catch {
        // If processState isn't available yet, continue without default context
      }
    }

    const formattedMsg = formatWithContext(message, effectiveContext);
    const style = getLogStyle(safeStatus);
    const colorFn = createAnsiColorFunction(style.color);

    // Use configuration from LOG_METHOD_CONFIG
    super.print(formattedMsg, config.label, colorFn, config.consoleMethod);

    if (configSettings?.logToFile) {
      logToFile(formattedMsg, customLog);
    }
  }
}

// Create a default instance at module load time - this is intentional for singleton pattern
const defaultLogger = new Log76(LogLevel.Standard, { color: true });

// Define Logger as just a type alias for Log76 for compatibility
export type Logger = Log76;

// Export the default logger instance as a singleton
export const logger: Logger = defaultLogger;

/**
 * Initialize logger with options
 * @returns The configured logger instance
 *
 * Note: This doesn't create a new logger instance, but configures the singleton.
 * This is intentional to avoid multiple logger instances throughout the application.
 */
export const initLogger = (options: LoggerOptions = {}): Logger => {
  if (loggerInitialized) {
    // Don't show duplicate warning - just return the existing instance
    return logger;
  }

  loggerInitialized = true;
  configSettings = options;

  // Set log level based on options
  const envLogLevel = options.logLevel || "standard";
  switch (envLogLevel.toLowerCase()) {
    case "quiet":
      logLevel = LogLevel.Quiet;
      break;
    case "trace":
      logLevel = LogLevel.Trace;
      break;
    case "debug":
      logLevel = LogLevel.Debug;
      break;
    default:
      logLevel = LogLevel.Standard;
      break;
  }

  // Configure the existing singleton logger instance
  logger.logLevel = logLevel;

  // Set the instance property to itself for compatibility
  Object.defineProperty(logger, "instance", {
    value: logger,
    writable: false,
  });

  // Avoid duplicating startup messages in shard processes
  if (!startupMessageShown && !options.silent) {
    // Check if we're a shard process
    const isShard = process.argv.includes("--is-shard") || process.env.IS_SHARD === "true";

    // For shards, use trace level to minimize console spam
    if (isShard) {
      logger.trace(`Logger initialized in shard process ${process.pid}`);
    } else {
      // Main process can use debug level
      logger.debug(`Logger initialized in main process ${process.pid}`);
    }
    startupMessageShown = true;
  }

  return logger;
};

/**
 * Ensure log directory exists
 * @param customDir Optional custom directory path to ensure exists
 */
export const ensureLogDirectoryExists = (customDir?: string): void => {
  const dirToCheck = customDir || logDir;

  if (!existsSync(dirToCheck)) {
    mkdirSync(dirToCheck, { recursive: true });
  }
};

/**
 * Initialize log file
 * @param customDir Optional custom directory path for the log file
 * @param customFilename Optional custom filename for the log
 */
export const initLogFile = (customDir?: string, customFilename?: string): void => {
  const dir = customDir || logDir;
  const file = customFilename ? path.join(dir, customFilename) : logFile;

  ensureLogDirectoryExists(dir);

  try {
    const stats = statSync(file);
    if (stats.isDirectory()) {
      writeFileSync(`${file}.old`, "");
      writeFileSync(file, "", { mode: 0o666 });
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      writeFileSync(file, "", { mode: 0o666 });
    } else {
      throw e;
    }
  }
};

/**
 * Write a message to the log file
 * @param message The message to write to the log
 * @param customLogFile Optional full path to a custom log file
 */
export function logToFile(message: string, customLog?: string): void {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${stripVTControlCharacters(message)}\n`;

  // Use customLogFile if provided, otherwise fall back to default logFile
  const fileToUse = customLog ? path.join(logDir, customLog) : logFile;

  try {
    // Make sure the directory exists for the file
    const dir = path.dirname(fileToUse);
    ensureLogDirectoryExists(dir);

    appendFileSync(fileToUse, logMessage, { encoding: "utf8" });
  } catch (error) {
    console.error(`Failed to write to log file ${fileToUse}: ${error}`);
  }
}

/**
 * Safe logging utility that works before logger is initialized
 * This is specifically designed for very early startup logging
 * or situations where we can't be certain the logger is ready
 */
export async function safeLog(level: string, message: string, context?: string): Promise<void> {
  // Validate the log level is one we expect
  const safeLevel = isValidStatusType(level) ? level : "info";

  // Try to use the logger singleton if it's available
  if (logger) {
    try {
      // Get config and potential fallback level
      const config = LOG_METHOD_CONFIG.get(safeLevel);
      const methodName = config?.fallbackLevel || safeLevel;

      if (isValidStatusType(methodName)) {
        // Use a type-safe approach with explicit method calls
        switch (methodName) {
          case "error":
            logger.error(message, context);
            return;
          case "warning":
            logger.warning(message, context);
            return;
          case "warn":
            logger.warn(message, context);
            return;
          case "success":
            logger.success(message, context);
            return;
          case "done":
            logger.done(message, context);
            return;
          case "info":
            logger.info(message, context);
            return;
          case "debug":
            logger.debug(message, context);
            return;
          case "trace":
            logger.trace(message, context);
            return;
          case "log":
            logger.log(message, context);
            return;
        }
      }
    } catch {
      // Fall back to shared fallback if logger method fails
    }
  }

  // Use shared fallback implementation if logger isn't available or fails
  fallbackConsoleLog(safeLevel, message, context, true);
}

// Make sure the log directory exists on module load
ensureLogDirectoryExists();

// For backward compatibility and export
export { LogLevel };
export default Log76;
