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

export const ensureLogFileExists = () => {
  ensureLogDirectoryExists();
  try {
    const stats = fs.statSync(logFilePath);
    if (stats.isDirectory()) {
      fs.rmdirSync(logFilePath, { recursive: true });
    } else if (stats.isFile()) {
      fs.unlinkSync(logFilePath);
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fs.writeFileSync(logFilePath, '', { mode: 0o666 });
};

export const logToFile = (message: string) => {
  ensureLogFileExists();
  fs.appendFileSync(logFilePath, `${new Date().toISOString()} - ${stripVTControlCharacters(message)}\n`);
};
