import { Collection } from "discord.js"
import { readdirSync, statSync } from "fs"
import path from "path"
import { setCommand } from "../bot"
import { Command } from "../interfaces/command"
import { ErrorSeverity, handleApiError } from "./errorSystem"
import { logger } from "./logger"

// Store loaded commands - prefix with underscore to indicate intentionally unused
const _commands = new Collection<string, Command>()
const _devServerCommands = new Collection<string, Command>();

/**
 * Get all command files with specific extensions from a directory (non-recursive)
 */
function getCommandFiles(directory: string, extensions: string[]): string[] {
  if (!directory) return [];

  try {
    return readdirSync(directory).filter((file) => {
      const filePath = path.join(directory, file);
      const stats = statSync(filePath);
      return stats.isFile() && extensions.some((ext) => file.endsWith(ext));
    });
  } catch (error) {
    logger.error(`Error reading directory ${directory}: ${error}`);
    return [];
  }
}

/**
 * Recursively load commands from a subdirectory
 */
async function loadCommandsFromDirectory(
  baseDir: string,
  subDir: string,
  commands: Collection<string, Command> = new Collection<string, Command>()
): Promise<Collection<string, Command>> {
  const fullPath = path.join(baseDir, subDir);
  logger.trace(`Loading commands from subdirectory: ${fullPath}`);

  const files = readdirSync(fullPath);

  for (const file of files) {
    const filePath = path.join(fullPath, file);
    const fileStat = statSync(filePath);

    if (fileStat.isDirectory()) {
      // Recursively process subdirectories
      await loadCommandsFromDirectory(fullPath, file, commands);
    } else if (fileStat.isFile() && (file.endsWith(".js") || file.endsWith(".ts"))) {
      // Process command file
      await handleApiError(
        null,
        async () => {
          const commandModule = await import(filePath);
          const cmdReq = commandModule.default;

          if (!cmdReq) {
            logger.warn(`"${filePath}" command does not export a default object`);
            return;
          }

          // Extract command properties
          const { run, data, gatekeeping, autocomplete, externalOptions } = cmdReq;

          if (!run || !data) {
            logger.warn(
              `"${filePath}" is not an acceptable command file. Missing: ${run ? "" : 'function "run"'} ${data ? "" : 'property "data"'}`
            );
            return;
          }

          // Get command name from filename without extension
          const commandName = file.split(".")[0];

          // Store command with all required properties
          commands.set(commandName, {
            run,
            data,
            gatekeeping,
            autocomplete,
            externalOptions,
          });

          logger.trace(`Loaded command: ${commandName} from ${filePath}`);
        },
        {
          retries: 2,
          retryDelay: 500,
          reportAtSeverity: ErrorSeverity.HIGH,
          context: `Command Loading (${file})`,
        }
      );
    }
  }

  return commands;
}

export default async function loadCommands(): Promise<Collection<string, Command>> {
  const commands = new Collection<string, Command>();
  const commandDirs = [
    path.join(__dirname, "..", "commands"),
    path.join(__dirname, "..", "commands", "private"),
    path.join(__dirname, "..", "commands", "public"),
  ];

  for (const dir of commandDirs) {
    try {
      logger.trace(`Loading commands from: ${dir}`);
      const commandFiles = getCommandFiles(dir, [".js", ".ts"]);

      await Promise.all(
        commandFiles.map(async (file) => {
          const filePath = path.join(dir, file);
          const fileStat = statSync(filePath);

          if (fileStat.isFile() && (file.endsWith(".js") || file.endsWith(".ts"))) {
            return handleApiError(
              null,
              async () => {
                const modulePath = path.join(dir, file);
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
            const subCommands = await loadCommandsFromDirectory(dir, file);

            // Merge the loaded commands into our collection
            for (const [name, command] of subCommands) {
              commands.set(name, command);
            }
          }
          return null;
        })
      );
    } catch (error) {
      logger.error(`Failed to read commands directory: ${error}`);
    }
  }

  // Update the global commands collection
  for (const [name, command] of commands.entries()) {
    setCommand(name, command);
  }

  return commands;
}
