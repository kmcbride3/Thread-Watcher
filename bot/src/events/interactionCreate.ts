import {
  BaseInteraction,
  ColorResolvable,
  EmbedBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  Events,
  Interaction,
  MessageFlagsBitField,
} from "discord.js";
import { config, logger } from "../index";
import { commands } from "../bot";
import { Command } from "../interfaces/command";
import { BuildBaseEmbedFunction, statusType, baseEmbedOptions } from "../interfaces/command";
import { ButtonInteractionQueue } from "../components/Button";
import { ModalInteractionQueue } from "../components/Modal";
import { StringSelectInteractionQueue } from "../components/StringSelect";
import TwGenericComponent from "../interfaces/genericComponent";

/**
 * Creates a styled embed for command responses
 */
const buildBaseEmbed: BuildBaseEmbedFunction = (
  title: string,
  status: statusType = statusType.info,
  misc?: baseEmbedOptions
): EmbedBuilder => {
  const style = config.style[status];
  const embed = new EmbedBuilder()
    .setColor(style.colour as ColorResolvable)
    .setTitle(`${style.emoji} ${title}`);

  if (misc?.description) embed.setDescription(misc.description);
  if (misc?.color) embed.setColor(misc.color);
  if (misc?.fields) embed.addFields(...misc.fields);
  if (!misc?.ephermal) embed.setTimestamp();

  return embed;
};

/**
 * Helper function to send a response with the embed
 */
const sendResponse = async (
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder,
  options?: baseEmbedOptions
): Promise<void> => {
  try {
    if (options?.showAuthor) {
      embed.setAuthor({
        iconURL: interaction.user.displayAvatarURL(),
        name: interaction.user.username,
      });
    }

    // Create response options with ephemeral property (simpler approach)
    const responseOptions = {
      embeds: [embed],
      components: [...(options?.components || [])],
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(responseOptions);
    } else {
      await interaction.reply(responseOptions);
    }
  } catch (err) {
    logger.error("sendResponse failed");
    logger.error((err as Error).toString());
  }
};

/**
 * Helper function to handle command errors
 */
function handleCommandError(err: unknown, interaction: ChatInputCommandInteraction): void {
  if (err instanceof Error) {
    logger.error(`Command execution failed: ${err.message}`);
    if (err.stack) logger.error(err.stack);
  } else {
    logger.error(`Command execution failed with unknown error: ${String(err)}`);
  }

  // Try to respond to the user
  try {
    const errDetails = `
If this error persists, please report it ${
      config.devServerInvite && config.devServerInvite !== "https://discord.gg/server"
        ? `on the [support server](${config.devServerInvite})`
        : "on the repository issues"
    }.
`;

    const errorOptions = {
      content: `There was an error executing this command!\n${errDetails}`,
      ephemeral: true, // Changed from flags to ephemeral property
    };

    if (interaction.replied || interaction.deferred) {
      interaction.editReply(errorOptions).catch(console.error);
    } else {
      interaction.reply(errorOptions).catch(console.error);
    }
  } catch (replyError) {
    logger.error(`Failed to send error response: ${replyError}`);
  }
}

/**
 * Validate all gatekeeping requirements for a command
 * @returns null if all checks pass, or an error embed if any check fails
 */
function validateGatekeeping(
  interaction: ChatInputCommandInteraction,
  command: Command
): EmbedBuilder | null {
  const gatekeeping = command.gatekeeping;
  if (!gatekeeping) return null;

  // Check owner permissions
  if (gatekeeping.ownerOnly && !config.owners.includes(interaction.user.id)) {
    return buildBaseEmbed("Owner Only", statusType.error, {
      description: `Command \`${interaction.commandName}\` is restricted to owner${config.owners.length > 1 ? "s" : ""}.`,
      ephermal: true,
    });
  }

  // Check dev server only
  if (
    gatekeeping.devServerOnly &&
    interaction.guild &&
    config.devServer &&
    interaction.guild.id !== config.devServer
  ) {
    return buildBaseEmbed("Dev Server Only", statusType.error, {
      description: `Command \`${interaction.commandName}\` can only be used in the development server.`,
      ephermal: true,
    });
  }

  // Check user permissions
  if (
    gatekeeping.userPermissions &&
    !interaction.memberPermissions?.has(gatekeeping.userPermissions)
  ) {
    const missing = interaction.memberPermissions?.missing(gatekeeping.userPermissions);
    return buildBaseEmbed("Missing Permissions", statusType.error, {
      description: `Command \`${interaction.commandName}\` requires additional permissions.`,
      fields: [
        {
          name: "You are missing",
          value: `${missing?.map((m) => `\`${m}\``).join(", ") || "None"}`,
        },
      ],
      ephermal: true,
    });
  }

  // Check bot permissions
  if (gatekeeping.botPermissions && !interaction.appPermissions?.has(gatekeeping.botPermissions)) {
    const missing = interaction.appPermissions?.missing(gatekeeping.botPermissions);
    return buildBaseEmbed("Missing Permissions", statusType.error, {
      description: `Command \`${interaction.commandName}\` requires the bot to have additional permissions.`,
      fields: [
        {
          name: "I am missing",
          value: `${missing?.map((m) => `\`${m}\``).join(", ") || "None"}`,
        },
      ],
      ephermal: true,
    });
  }

  // All checks passed
  return null;
}

/**
 * Handle autocompletion for commands
 */
const handleAutoComplete = async (interaction: AutocompleteInteraction): Promise<void> => {
  const command = commands.get(interaction.commandName);
  if (command?.autocomplete) {
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      logger.error(`Error in autocomplete for command ${interaction.commandName}: ${err}`);
    }
  }
};

/**
 * Process button, modal, and select menu interactions
 */
function handleComponentInteraction<T extends BaseInteraction & { customId: string }>(
  interaction: T,
  queue: Map<string, TwGenericComponent<T>>
): void {
  const component = queue.get(interaction.customId);
  if (component) {
    component.middleware(interaction);
  } else if (interaction.isRepliable()) {
    interaction.reply({
      content: `No handler found for interaction with id \`${interaction.customId}\`.`,
      flags: [MessageFlagsBitField.Flags.Ephemeral],
    });
  }
}

export default {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);

      // Handle unknown commands
      if (!command) {
        if (interaction.isRepliable()) {
          await interaction.reply({
            content: `Command \`${interaction.commandName}\` not found.`,
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        }
        return;
      }

      // Check if channel exists
      if (!interaction.channel) {
        sendResponse(
          interaction,
          buildBaseEmbed("Unknown Channel", statusType.error, {
            description:
              "Your interaction happened in an unknown channel.\n" +
              "**If this is a DM:** run it in a server. Thread-Watcher does not support DMs\n" +
              "**If this is not a DM:** something went wrong. Try again later.",
            ephermal: true,
          })
        );
        return;
      }

      // Perform all gatekeeping checks
      const gatekeepingError = validateGatekeeping(interaction, command);
      if (gatekeepingError) {
        sendResponse(interaction, gatekeepingError);
        return;
      }

      // Create a wrapped version of buildBaseEmbed that also sends the response
      const wrappedBuildBaseEmbed: BuildBaseEmbedFunction = (title, status, options) => {
        const embed = buildBaseEmbed(title, status, options);

        // Send the response unless noSend is specified
        if (!options?.noSend) {
          sendResponse(interaction, embed, options);
        }

        return embed;
      };

      // Execute the command
      try {
        // Use run if available, otherwise fall back to execute for backwards compatibility
        if (command.run) {
          await command.run(interaction, wrappedBuildBaseEmbed).catch((err) => {
            handleCommandError(err, interaction);
          });
        } else if (command.execute) {
          await command.execute(interaction, wrappedBuildBaseEmbed).catch((err) => {
            handleCommandError(err, interaction);
          });
        } else {
          logger.error(`Command ${interaction.commandName} has neither run nor execute methods`);
          await interaction.reply({
            content: "There was an error with this command implementation!",
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        }
      } catch (error) {
        logger.error(`Unhandled error in command ${interaction.commandName}: ${error}`);
        handleCommandError(error, interaction);
      }
    }
    // Handle other interaction types
    else if (interaction.isAutocomplete()) {
      await handleAutoComplete(interaction);
    } else if (interaction.isButton()) {
      handleComponentInteraction(interaction, ButtonInteractionQueue);
    } else if (interaction.isModalSubmit()) {
      handleComponentInteraction(interaction, ModalInteractionQueue);
    } else if (interaction.isStringSelectMenu()) {
      handleComponentInteraction(interaction, StringSelectInteractionQueue);
    }
  },
};
