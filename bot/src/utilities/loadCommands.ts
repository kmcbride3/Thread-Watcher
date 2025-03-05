import { readdirSync, statSync } from "fs";
import { Command } from "../interfaces/command";
import { logger } from "../index";
import path from "path";
import { Collection } from "discord.js";

export default async function loadCommands(
  baseDir = "../commands/",
  dirDive = ""
): Promise<Collection<string, Command>> {
  const commands = new Collection<string, Command>();

  try {
    const p = path.join(__dirname, baseDir + (dirDive ? dirDive : ""));
    logger.debug(`Loading commands from: ${p}`);

    for (const file of readdirSync(p)) {
      try {
        const filePath = path.join(p, file);
        const fileStat = statSync(filePath);

        if (fileStat.isFile() && file.endsWith(".js")) {
          const modulePath = path.join(baseDir, dirDive, file);
          const commandModule = await import(modulePath);

          const cmdReq = commandModule.default;

          if (!cmdReq) {
            logger.warn(`"${baseDir}${dirDive}${file}" command does not export a default object`);
            continue;
          }

          // Extract command properties
          const { run, data, gatekeeping, autocomplete, externalOptions } = cmdReq;

          if (!run || !data) {
            logger.warn(
              `"${baseDir}${dirDive}${file}" is not an acceptable command file. Missing: ${run ? "" : "function \"run\""} ${data ? "" : "property \"data\""}`
            );
          } else {
            // Store command with all required properties
            commands.set(file.split(".")[0], {
              run,
              data,
              gatekeeping,
              autocomplete,
              externalOptions,
            });
          }
        } else if (fileStat.isDirectory()) {
          // Recursively load commands from subdirectories
          const subCommands = await loadCommands(baseDir, dirDive + `${file}/`);
          subCommands.forEach((value, key) => commands.set(key, value));
        }
      } catch (error) {
        logger.error(`Failed to load command ${file}: ${error}`);
      }
    }
  } catch (error) {
    logger.error(`Failed to read commands directory: ${error}`);
  }

  return commands;
}
