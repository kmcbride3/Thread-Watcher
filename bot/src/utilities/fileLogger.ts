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
  if (fs.existsSync(logFilePath)) {
    // If the path exists but is a directory, remove it first.
    if (fs.statSync(logFilePath).isDirectory()) {
      fs.rmdirSync(logFilePath, { recursive: true });
    }
  }
  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, '', { mode: 0o666 });
  }
};

export const logToFile = (message: string) => {
  ensureLogFileExists();
  fs.appendFileSync(logFilePath, `${new Date().toISOString()} - ${stripVTControlCharacters(message)}\n`);
};
