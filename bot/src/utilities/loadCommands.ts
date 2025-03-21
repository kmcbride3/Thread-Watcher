import { REST } from "@discordjs/rest";
import { Collection, Routes } from "discord.js";
import { readdirSync, statSync } from "fs";
import path from "path";
import { setCommand } from "../bot";
import { config, logger } from "../index";
import { Command } from "../interfaces/command";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { validateCommandOptions } from "./commandValidator";
import { ErrorSeverity, handleApiError } from "./errorSystem";

// Store loaded commands
const commands = new Collection<string, Command>();
const devServerCommands = new Collection<string, Command>();

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

/**
 * Register commands with Discord API
 */
export async function registerCommands(): Promise<void> {
  if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
    throw new Error("Client not available for command registration");
  }

  const client = serviceRegistry.get(SERVICE_KEYS.CLIENT);

  logger.debug("Registering commands...", "COMMANDS");

  try {
    // Validate commands before registering
    const validationErrors = validateCommandOptions(Array.from(commands.values()));
    if (validationErrors.length > 0) {
      logger.error("Command validation failed with the following errors:");
      validationErrors.forEach((error) => {
        logger.error(`- ${error.commandName}: ${error.message}`);
      });
      throw new Error("Command validation failed - check logs for details");
    }

    const rest = new REST({ version: "10" }).setToken(config.tokens.discord);

    // Register global commands
    if (commands.size > 0) {
      logger.info(`Registering ${commands.size} commands globally`);

      const commandData = commands.map((cmd) => cmd.data.toJSON());

      await handleApiError(
        "Failed to register global commands",
        async () => {
          await rest.put(Routes.applicationCommands(client.user?.id || config.clientID), {
            body: commandData,
          });
          logger.done(`Successfully registered ${commands.size} global commands`);
        },
        {
          retries: 3,
          retryDelay: 60000, // 1 minute retry delay due to rate limits
          context: "Global Command Registration",
          reportAtSeverity: ErrorSeverity.HIGH,
        }
      );
    }

    // Register dev server commands
    if (config.devServer && devServerCommands.size > 0) {
      logger.info(`Registering ${devServerCommands.size} commands to development server`);

      const devCommandData = devServerCommands.map((cmd) => cmd.data.toJSON());

      await handleApiError(
        "Failed to register development server commands",
        async () => {
          await rest.put(
            Routes.applicationGuildCommands(client.user?.id || config.clientID, config.devServer),
            { body: devCommandData }
          );
          logger.done(
            `Successfully registered ${devServerCommands.size} development server commands`
          );
        },
        {
          retries: 3,
          retryDelay: 30000, // 30 second retry delay
          context: "Dev Server Command Registration",
          reportAtSeverity: ErrorSeverity.MEDIUM,
        }
      );
    }
  } catch (error) {
    logger.error(
      `Command registration failed: ${error instanceof Error ? error.message : String(error)}`
    );
    if (error instanceof Error && error.stack) {
      logger.debug(`Stack trace: ${error.stack}`);
    }
    throw error; // Re-throw for higher-level handling
  }
}
