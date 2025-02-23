import { Command } from "src/interfaces/command";
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
import { logger } from "../bot";
import { createHash } from "crypto";
import loadCommands from "./loadCommands";

export const registerCommands = async (global: boolean, config: ConfigFile) => {
  const commandsMap = loadCommands("../commands/");
  const publicCommands: Command[] = [];
  const privateCommands: Command[] = [];

  commandsMap.forEach((cmd) => {
    if (cmd.gatekeeping?.devServerOnly) {
      privateCommands.push(cmd);
    } else {
      publicCommands.push(cmd);
    }
  });

  if (!global && !config.devServer) {
    console.warn(
      "-reg_commands was used with the -local flag but no dev server is specified in config.\nPlease edit the config to include the id of your development server or remove the -local flag to register commands globally",
    );
    return new Promise((_res, rej) => rej("no dev server specified in config"));
  }
  console.log(
    `Registering commands ${global ? "globally" : `on your server (${config.devServer})`}`,
  );
  console.log(
    `Global commands:\n${publicCommands.map((c) => c.data.name).join(", ")}\nLocal commands:\n${privateCommands.map((c) => c.data.name).join(", ")}`,
  );

  if (!global && config.devServer) {
    privateCommands.push(...publicCommands);
    publicCommands.splice(0, publicCommands.length);
}

  const rest = new REST({ version: "10" }).setToken(config.tokens.discord);

  const commandToJson = (cmd: Command) => {
    const data = cmd.data.toJSON();
    if (cmd.externalOptions) data.options?.push(...cmd.externalOptions);
    return data;
  };

  const existingCommands: { name: string }[] = await rest.get(
    global
      ? Routes.applicationCommands(config.clientID)
      : Routes.applicationGuildCommands(config.clientID, config.devServer)
  ) as { name: string }[];

  const newCommands = global ? publicCommands : privateCommands;
  const commandsToRegister = newCommands.filter(
    (cmd) => !(existingCommands as { name: string }[]).some((existingCmd) => existingCmd.name === cmd.data.name)
  );

  if (commandsToRegister.length > 0) {
    const route = global
      ? Routes.applicationCommands(config.clientID)
      : Routes.applicationGuildCommands(config.clientID, config.devServer);
    await rest.put(route, {
      body: commandsToRegister.map(commandToJson),
    });
    logger.done(`Registered ${commandsToRegister.length} commands successfully.`);
  }
};

export const clearCommands = async (local: boolean, config: ConfigFile) => {
  const rest = new REST({ version: "10" }).setToken(config.tokens.discord);
  const route = local
    ? Routes.applicationGuildCommands(config.clientID, config.devServer)
    : Routes.applicationCommands(config.clientID);
  await rest.put(route, { body: [] });
  logger.done(`Cleared all ${local ? "local" : "global"} commands successfully.`);
};

export function genCommandHash(writeToFile = true): string {
  const commandsMap = loadCommands("../commands/");
  const hash = createHash("sha256");

  commandsMap.forEach((command) => {
    const commandInfo = `${JSON.stringify(command.data)}:${JSON.stringify(command.externalOptions ?? "")}`;
    hash.update(commandInfo);
  });

  const digest = hash.digest("base64");

  if (writeToFile) {
    const hashFilePath = path.resolve(__dirname, '../../.commandshash');
    const hashDir = path.dirname(hashFilePath);

    // Ensure the directory exists and has the correct permissions
    if (!existsSync(hashDir)) {
      mkdirSync(hashDir, { recursive: true });
      chmodSync(hashDir, 0o775); // Set directory permissions to 775
    }

    // Ensure the .commandshash file exists and has the correct permissions
    writeFileSync(hashFilePath, digest, { mode: 0o666 });
  }

  return digest;
}

export function checkCommandChange(): boolean {
  const oldHashPath = path.join(__dirname, "../../.commandshash");

  const oldHash = existsSync(oldHashPath)
    ? readFileSync(oldHashPath, "utf8")
    : Buffer.from("file does not exist").toString("base64");
  const currentHash = genCommandHash();

  return oldHash === currentHash;
}
