import { Collection } from "discord.js";
import { readdirSync, statSync } from "fs";
import path from "path";
import { logger } from "../index";
import { Command } from "../interfaces/command";
import { ErrorSeverity, handleApiError } from "./errorSystem";

export default async function loadCommands(
  baseDir = "../commands/",
  dirDive = ""
): Promise<Collection<string, Command>> {
  const commands = new Collection<string, Command>();

  const loadCommandsFromDirectory = async (dirPath: string, recursionPath = ""): Promise<void> => {
    try {
      const fullPath = path.join(dirPath, recursionPath);
      logger.debug(`Loading commands from: ${fullPath}`);

      const files = readdirSync(fullPath);

      await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(fullPath, file);
          const fileStat = statSync(filePath);

          if (fileStat.isFile() && file.endsWith(".js")) {
            return handleApiError(
              null,
              async () => {
                const modulePath = path.join(baseDir, recursionPath, file);
                const commandModule = await import(modulePath);
                const cmdReq = commandModule.default;

                if (!cmdReq) {
                  logger.warn(`"${modulePath}" command does not export a default object`);
                  return;
                }

                // Extract command properties
                const { run, data, gatekeeping, autocomplete, externalOptions } = cmdReq;

                if (!run || !data) {
                  logger.warn(
                    `"${modulePath}" is not an acceptable command file. Missing: ${run ? "" : 'function "run"'} ${data ? "" : 'property "data"'}`
                  );
                  return;
                }

                // Store command with all required properties
                commands.set(file.split(".")[0], {
                  run,
                  data,
                  gatekeeping,
                  autocomplete,
                  externalOptions,
                });
              },
              {
                retries: 2,
                retryDelay: 500,
                reportAtSeverity: ErrorSeverity.HIGH,
                context: `Command Loading (${file})`,
              }
            );
          } else if (fileStat.isDirectory()) {
            // Recursively load commands from subdirectories
            return await loadCommandsFromDirectory(dirPath, path.join(recursionPath, file));
          }
          return null;
        })
      );
    } catch (error) {
      logger.error(`Failed to read commands directory: ${error}`);
    }
  };

  const commandsPath = path.join(__dirname, baseDir);
  await loadCommandsFromDirectory(commandsPath, dirDive);

  return commands;
}
