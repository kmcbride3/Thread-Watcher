import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';

const logFilePath = path.join(__dirname, '../../data/thread-watcher.log');

export const ensureLogDirectoryExists = () => {
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
};

// Initialize log file only once instead of on every log call
export const initLogFile = () => {
  ensureLogDirectoryExists();
  try {
    const stats = fs.statSync(logFilePath);
    // If the file path exists but is a directory, rename it as a fallback
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

// Append messages without reinitializing the log file each time
export const logToFile = (message: string) => {
  fs.appendFileSync(logFilePath, `${new Date().toISOString()} - ${stripVTControlCharacters(message)}\n`);
};
