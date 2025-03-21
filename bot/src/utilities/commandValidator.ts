import {
  ApplicationCommandSubCommandData,
  Collection,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { logger } from "../index";
import { Command } from "../interfaces/command";

interface ValidationError {
  commandName: string;
  message: string;
}

/**
 * Validate command options for potential issues before registration
 * @param commands Array of commands to validate
 * @returns Array of validation errors, empty if all valid
 */
export function validateCommandOptions(commands: Command[]): ValidationError[] {
  const errors: ValidationError[] = [];

  commands.forEach((command) => {
    try {
      if (!command.data) {
        errors.push({
          commandName: "unknown",
          message: "Command data is missing",
        });
        return;
      }

      const commandName = command.data.name || "unknown";
      logger.debug(`Validating command: ${commandName}`);

      // Start validation at the top level - renamed function to avoid name collision
      validateCommandBuilderOptions(command.data, commandName, errors);

      // Check for duplicate names between data.options and externalOptions
      if (command.externalOptions && Array.isArray(command.externalOptions)) {
        const optionNames = new Set<string>();

        // First collect all existing option names
        command.data.options.forEach((option) => {
          if ("name" in option && typeof option.name === "string") {
            optionNames.add(option.name);
          }
        });

        // Then check for duplicates in externalOptions
        command.externalOptions.forEach((option) => {
          if (typeof option === "object" && option !== null && "name" in option) {
            const name = option.name as string;
            if (optionNames.has(name)) {
              errors.push({
                commandName,
                message: `Duplicate option name '${name}' detected between regular options and externalOptions`,
              });
              logger.warn(
                `Command '${commandName}' has duplicate option name across option types: ${name}`
              );
            } else {
              optionNames.add(name);
            }
          }
        });
      }
    } catch (error) {
      errors.push({
        commandName: command.data?.name || "unknown",
        message: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  return errors;
}

/**
 * Validate options on a command builder
 * Renamed from validateCommandOptions to avoid name collision
 */
function validateCommandBuilderOptions(
  builder:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | Omit<SlashCommandBuilder, "addSubcommandGroup" | "addSubcommand">,
  commandName: string,
  errors: ValidationError[]
): void {
  // Track option names at each level to detect duplicates
  const optionNames = new Collection<string, number>();

  // Check each option
  builder.options.forEach((option) => {
    // Get option name
    if (!("name" in option)) {
      errors.push({
        commandName,
        message: `Option missing name property`,
      });
      return;
    }

    const optionName = option.name as string;

    // Track option name occurrence
    const count = optionNames.get(optionName) || 0;
    optionNames.set(optionName, count + 1);

    // Check for duplicate names
    if (count > 0) {
      errors.push({
        commandName,
        message: `Duplicate option name '${optionName}' detected`,
      });
      logger.warn(`Command '${commandName}' has duplicate option name: ${optionName}`);
    }
    // Check for subcommands and subcommand groups
    if ("type" in option) {
      if (option.type === 1) {
        // Subcommand
        validateSubcommandOptions(
          option as unknown as ApplicationCommandSubCommandData,
          `${commandName} -> ${optionName}`,
          errors
        );
      } else if (option.type === 2) {
        // Subcommand group
        validateSubcommandGroupOptions(
          option as unknown as ApplicationCommandSubCommandData,
          `${commandName} -> ${optionName}`,
          errors
        );
      }
    }
  });
}

/**
 * Validate options in a subcommand
 */
function validateSubcommandOptions(
  subcommand: ApplicationCommandSubCommandData,
  path: string,
  errors: ValidationError[]
): void {
  // Skip if no options
  if (!subcommand.options || !Array.isArray(subcommand.options)) {
    return;
  }

  const optionNames = new Collection<string, number>();

  subcommand.options.forEach((option) => {
    // Track option names
    const optionName = option.name;

    const count = optionNames.get(optionName) || 0;
    optionNames.set(optionName, count + 1);

    // Check for duplicate names
    if (count > 0) {
      errors.push({
        commandName: path,
        message: `Duplicate option name '${optionName}' detected`,
      });
      logger.warn(`Duplicate option name '${optionName}' detected in: ${path}`);
    }
  });
}

/**
/**
 * Validate options in a subcommand group
 */
function validateSubcommandGroupOptions(
  group: ApplicationCommandSubCommandData,
  path: string,
  errors: ValidationError[]
): void {
  // Skip if no options
  if (!group.options || !Array.isArray(group.options)) {
    return;
  }

  const optionNames = new Collection<string, number>();

  group.options.forEach((option) => {
    // Track option names
    const optionName = option.name;

    const count = optionNames.get(optionName) || 0;
    optionNames.set(optionName, count + 1);

    // Check for duplicate names
    if (count > 0) {
      errors.push({
        commandName: path,
        message: `Duplicate option name '${optionName}' detected`,
      });
      logger.warn(`Duplicate option name '${optionName}' detected in: ${path}`);
    }

    // Recursively check subcommands within this group
    if ("type" in option && option.type === 1 && "options" in option) {
      // Subcommand
      validateSubcommandOptions(
        option as ApplicationCommandSubCommandData,
        `${path} -> ${optionName}`,
        errors
      );
    }
  });
}
