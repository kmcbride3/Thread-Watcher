import { Command } from "../interfaces/command";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "fs";
import path from "path";
import { REST, Routes } from "discord.js";
import { ConfigFile } from "./cnf/index";
import { createHash } from "crypto";
import loadCommands from "./loadCommands";
import { logger } from "../index";

export async function registerCommands(global: boolean, config: ConfigFile): Promise<void> {
  logger.debug(`Loading commands for registration (${global ? "global" : "local"})`);
  
  try {
    const commandsCollection = await loadCommands();
    const publicCommands: Command[] = [];
    const privateCommands: Command[] = [];
    
    commandsCollection.forEach(cmd => {
      if (cmd.gatekeeping?.devServerOnly) {
        privateCommands.push(cmd);
      } else {
        publicCommands.push(cmd);
      }
    });
    
    if (publicCommands.length > 0) {
      logger.debug(`Found ${publicCommands.length} public commands`);
    }
    
    if (privateCommands.length > 0) {
      logger.debug(`Found ${privateCommands.length} dev-server-only commands`);
    }
    
    if (!global && !config.devServer) {
      logger.error("Local registration requested but no dev server configured in config.");
      return Promise.reject("No dev server specified in config");
    }
    
    const rest = new REST({ version: "10" }).setToken(config.tokens.discord);
    
    const commandToJson = (cmd: Command) => {
      const data = cmd.data.toJSON();
      if (cmd.externalOptions) data.options?.push(...cmd.externalOptions);
      return data;
    };
    
    const promises = [];
    
    if (global && publicCommands.length > 0) {
      logger.info(`Registering ${publicCommands.length} commands globally`);
      promises.push(
        rest.put(Routes.applicationCommands(config.clientID), {
          body: publicCommands.map(commandToJson)
        })
      );
    }
    
    if (config.devServer) {
      const devCommands = global ? privateCommands : [...publicCommands, ...privateCommands];
      
      if (devCommands.length > 0) {
        logger.info(`Registering ${devCommands.length} commands to development server`);
        promises.push(
          rest.put(Routes.applicationGuildCommands(config.clientID, config.devServer), {
            body: devCommands.map(commandToJson)
          })
        );
      }
    }
    
    if (promises.length > 0) {
      await Promise.all(promises);
      logger.done("Command registration successful");
    } else {
      logger.warn("No commands to register");
    }
    
  } catch (error) {
    logger.error(`Command registration failed: ${error}`);
    throw error;
  }
};

export async function clearCommands(local: boolean, config: ConfigFile): Promise<void> {
  try {
    const rest = new REST({ version: "10" }).setToken(config.tokens.discord);
    const route = local
      ? Routes.applicationGuildCommands(config.clientID, config.devServer)
      : Routes.applicationCommands(config.clientID);
    
    await rest.put(route, { body: [] });
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
