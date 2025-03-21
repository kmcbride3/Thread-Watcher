import { createHash } from "crypto";
import { Collection, REST, Routes } from "discord.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { logger } from "../index";
import { Command } from "../interfaces/command";
import { ConfigFile } from "./cnf/index";
import { validateCommandOptions } from "./commandValidator";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import loadCommands from "./loadCommands";
import { rateLimitManager } from "./rateLimitManager";

export async function registerCommands(global: boolean, config: ConfigFile): Promise<void> {
  logger.debug(`Loading commands for registration (${global ? "global" : "local"})`);

  try {
    const commandsCollection = await loadCommands();

    // Validate commands before proceeding with registration
    const validationErrors = validateCommandOptions(Array.from(commandsCollection.values()));
    if (validationErrors.length > 0) {
      logger.error("Command validation failed with the following errors:");
      validationErrors.forEach((error) => {
        logger.error(`- ${error.commandName}: ${error.message}`);
      });
      return Promise.reject(new Error("Command validation failed - check logs for details"));
    }

    const publicCommands = commandsCollection.filter((cmd) => !cmd.gatekeeping?.devServerOnly);
    const privateCommands = commandsCollection.filter((cmd) => cmd.gatekeeping?.devServerOnly);

    if (publicCommands.size > 0) {
      logger.debug(`Found ${publicCommands.size} public commands`);
    }

    if (privateCommands.size > 0) {
      logger.debug(`Found ${privateCommands.size} dev-server-only commands`);
    }

    if (!global && !config.devServer) {
      logger.error("Local registration requested but no dev server configured in config.");
      return Promise.reject(new Error("No dev server specified in config"));
    }

    const rest = new REST({ version: "10" }).setToken(config.tokens.discord);

    // Set up rate limit handling for the REST instance
    rest.on("rateLimited", (rateLimitInfo) => {
      rateLimitManager.handleRateLimit(rateLimitInfo);
    });

    const commandToJson = (cmd: Command) => {
      const data = cmd.data.toJSON();
      if (cmd.externalOptions)
        data.options?.push(
          ...(cmd.externalOptions as {
            name: string;
            description: string;
            type: number;
            required?: boolean;
            options?: unknown[];
          }[])
        );
      return data;
    };

    const registerPromises = [];

    if (global && publicCommands.size > 0) {
      logger.info(`Registering ${publicCommands.size} commands globally`);

      const registerGlobalCommands = async () => {
        // Wait for rate limit before proceeding with global command registration
        await rateLimitManager.waitForRateLimit("application/commands");
        return rest.put(Routes.applicationCommands(config.clientID), {
          body: publicCommands.map(commandToJson),
        });
      };

      registerPromises.push(
        handleApiError("Failed to register global commands", registerGlobalCommands, {
          retries: 3,
          retryDelay: 1000,
          reportAtSeverity: ErrorSeverity.HIGH,
          context: "Global Command Registration",
        })
      );
    }

    if (config.devServer) {
      const devCommands = global
        ? privateCommands
        : new Collection([...publicCommands.entries(), ...privateCommands.entries()]);

      if (devCommands.size > 0) {
        logger.info(`Registering ${devCommands.size} commands to development server`);

        const registerDevCommands = async () => {
          // Wait for rate limit before proceeding with dev server command registration
          await rateLimitManager.waitForRateLimit(
            `applications/${config.clientID}/guilds/${config.devServer}/commands`
          );
          return rest.put(Routes.applicationGuildCommands(config.clientID, config.devServer), {
            body: devCommands.map(commandToJson),
          });
        };

        registerPromises.push(
          handleApiError("Failed to register dev server commands", registerDevCommands, {
            retries: 3,
            retryDelay: 1000,
            reportAtSeverity: ErrorSeverity.HIGH,
            context: "Dev Server Command Registration",
          })
        );
      }
    }

    if (registerPromises.length > 0) {
      await Promise.all(registerPromises);
      logger.done("Command registration successful");
    } else {
      logger.warn("No commands to register");
    }
  } catch (error) {
    logger.error(`Command registration failed: ${error}`);
    throw error;
  }
  return Promise.resolve();
}

export async function clearCommands(local: boolean, config: ConfigFile): Promise<void> {
  try {
    const rest = new REST({ version: "10" }).setToken(config.tokens.discord);

    rest.on("rateLimited", (rateLimitInfo) => {
      rateLimitManager.handleRateLimit(rateLimitInfo);
    });

    const route = local
      ? Routes.applicationGuildCommands(config.clientID, config.devServer)
      : Routes.applicationCommands(config.clientID);

    const endpoint = local
      ? `applications/${config.clientID}/guilds/${config.devServer}/commands`
      : `applications/${config.clientID}/commands`;

    await rateLimitManager.waitForRateLimit(endpoint);

    await handleApiError(
      `Failed to clear ${local ? "local" : "global"} commands`,
      async () => await rest.put(route, { body: [] }),
      {
        retries: 3,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.HIGH,
        context: `Clear ${local ? "Local" : "Global"} Commands`,
      }
    );

    logger.done(`Cleared all ${local ? "local" : "global"} commands`);
  } catch (error) {
    logger.error(`Failed to clear commands: ${error}`);
    throw error;
  }
}

export async function genCommandHash(writeToFile = true): Promise<string> {
  try {
    const commands = await loadCommands();
    const hash = createHash("sha256");

    for (const [, command] of commands) {
      const commandInfo = `${JSON.stringify(command.data)}:${JSON.stringify(command.externalOptions ?? "")}`;
      hash.update(commandInfo);
    }

    const digest = hash.digest("base64");

    if (writeToFile) {
      const hashFilePath = path.resolve(process.cwd(), ".commandshash");
      const hashDir = path.dirname(hashFilePath);

      if (!existsSync(hashDir)) {
        mkdirSync(hashDir, { recursive: true });
        try {
          chmodSync(hashDir, 0o775);
        } catch (err) {
          logger.warn(`Failed to set directory permissions: ${err}`);
        }
      }

      writeFileSync(hashFilePath, digest);
      try {
        chmodSync(hashFilePath, 0o664);
      } catch (err) {
        logger.warn(`Failed to set hash file permissions: ${err}`);
      }

      logger.debug(`Command hash updated: ${digest.substring(0, 8)}...`);
    }

    return digest;
  } catch (error) {
    logger.error(`Failed to generate command hash: ${error}`);
    throw error;
  }
}

export async function checkCommandChange(): Promise<boolean> {
  try {
    const hashFilePath = path.resolve(process.cwd(), ".commandshash");

    const oldHash = existsSync(hashFilePath)
      ? readFileSync(hashFilePath, "utf8")
      : Buffer.from("file does not exist").toString("base64");

    const currentHash = await genCommandHash(false);
    const hasChanged = oldHash !== currentHash;

    if (hasChanged) {
      logger.debug("Commands have changed since last run, registration required");
    } else {
      logger.debug("Commands have not changed, registration can be skipped");
    }

    return hasChanged;
  } catch (error) {
    logger.error(`Failed to check command changes: ${error}`);
    return true;
  }
}
