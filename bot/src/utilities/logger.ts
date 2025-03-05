import Log75, { LogLevel } from "log75";
import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { trackInitState } from './debugUtils';

const logDir = join(__dirname, "../../data");
const logFile = join(logDir, "thread-watcher.log");
const logFilePath = path.join(__dirname, '../../data/thread-watcher.log');

let configSettings: { logLevel: string, logBold: boolean, logInverted: boolean, logToFile: boolean };

export class Log76 extends Log75 {
  constructor(level: number, options: { color: boolean; bold?: boolean; inverted?: boolean; maxTypeLength?: 5 }) {
    super(level ?? 1, options);
  }

  async error(s: string) {
    if (LogLevel.Standard <= logLevel) {
      super.error(s);
      if (configSettings?.logToFile) await logToFile(`[ERROR] ${s}`);
    }
  }

  async warn(s: string) {
    if (LogLevel.Standard <= logLevel) {
      super.warn(s);
      if (configSettings?.logToFile) await logToFile(`[WARN]  ${s}`);
    }
  }

  async done(s: string) {
    if (LogLevel.Standard <= logLevel) {
      super.done(s);
      if (configSettings?.logToFile) await logToFile(`[OK]    ${s}`);
    }
  }

  async info(s: string) {
    if (LogLevel.Standard <= logLevel) {
      super.info(s);
      if (configSettings?.logToFile) await logToFile(`[INFO]  ${s}`);
    }
  }

  async debug(s: string) {
    if (LogLevel.Debug <= logLevel) {
      super.debug(s);
      if (configSettings?.logToFile) await logToFile(`[DEBUG] ${s}`);
    }
  }

  async trace(s: string) {
    if (LogLevel.Trace <= logLevel) {
      super.trace(s);
      if (configSettings?.logToFile) {
        await logToFile(`[TRACE] ${s}`);
        trackInitState(s);
      }
    }
  }
}

let logLevel: number;
export let logger: Log76;

// Ensure logger is only initialized once
let loggerInitialized = false;

export interface LoggerOptions {
  logLevel?: string;
  logBold?: boolean;
  logInverted?: boolean;
  logToFile?: boolean;
  silent?: boolean; // Add this option
}

export const initLogger = (options: LoggerOptions = {}): void => {
  if (loggerInitialized) {
    console.warn(`initLogger already initialized in process ${process.pid}`);
    return;
  }
  loggerInitialized = true;
  
  // Only show initialization message if not silent
  if (!options.silent) {
    console.info(`Initializing logger in process ${process.pid}`);
  }
  
  // Store the config from index.ts here
  configSettings = options as { logLevel: string, logBold: boolean, logInverted: boolean, logToFile: boolean };
  // Using Log75's built-in levels and mapping our config log level.
  const envLogLevel = process.env.LOG_LEVEL || 'Standard';
  logLevel = LogLevel[envLogLevel as keyof typeof LogLevel] ?? LogLevel.Standard;
  // Pass the additional options 'bold' and 'inverted' to the constructor:
  logger = new Log76(logLevel, { 
    color: true,
    bold: options.logBold ?? false,
    inverted: options.logInverted ?? false,
    maxTypeLength: 5
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
    const stats = fs.statSync(logFilePath);
    if (stats.isDirectory()) {
      fs.renameSync(logFilePath, logFilePath + '.old');
      fs.writeFileSync(logFilePath, '', { mode: 0o666 });
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.writeFileSync(logFilePath, '', { mode: 0o666 });
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
