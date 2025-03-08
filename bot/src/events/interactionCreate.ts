import {
  BaseInteraction,
  ColorResolvable,
  EmbedBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  Events,
  Interaction,
  MessageFlagsBitField,
  ActionRowBuilder,
  MessageActionRowComponentBuilder,
} from "discord.js";
import { config, logger } from "../index";
import { commands } from "../bot";
import {
  Command,
  BuildBaseEmbedFunction,
  statusType,
  baseEmbedOptions,
} from "../interfaces/command";
import { ButtonInteractionQueue } from "../components/Button";
import { ModalInteractionQueue } from "../components/Modal";
import { StringSelectInteractionQueue } from "../components/StringSelect";
import TwGenericComponent from "../interfaces/genericComponent";
import { safeObjectAccess } from "../utilities/securityExceptions";

/**
 * Creates a styled embed for command responses
 */
const buildBaseEmbed: BuildBaseEmbedFunction = (
  title: string,
  status: statusType = statusType.info,
  misc?: baseEmbedOptions
): EmbedBuilder => {
  // Create a local copy of status instead of modifying the parameter
  const effectiveStatus = Object.values(statusType).includes(status) ? status : statusType.info;

  // Use safeObjectAccess to prevent object injection
  const style = safeObjectAccess(
    config.style,
    effectiveStatus,
    Object.values(statusType).map((s) => s.toString())
  ) as { colour: string; emoji: string };

  const embed = new EmbedBuilder()
    .setColor(style.colour as ColorResolvable)
    .setTitle(`${style.emoji} ${title}`);

  if (misc?.description) embed.setDescription(misc.description);
  if (misc?.color) embed.setColor(misc.color);
  if (misc?.fields) {
    const processedFields = misc.fields.map((field) => ({
      name: field.name,
      value: String(field.value),
      inline: field.inline,
    }));
    embed.addFields(processedFields);
  }

  if (
    !misc?.flags ||
    !(typeof misc.flags === "number" && misc.flags & MessageFlagsBitField.Flags.Ephemeral)
  ) {
    embed.setTimestamp();
  }

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

    const responseOptions: {
      embeds: EmbedBuilder[];
      components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
      flags?: number;
    } = {
      embeds: [embed],
      components: options?.components || [],
      flags: options?.flags ? new MessageFlagsBitField(options.flags).valueOf() : undefined,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(responseOptions).catch((error) => {
        logger.error(`Failed to edit reply: ${error}`);
      });
    } else {
      await interaction.reply(responseOptions).catch((error) => {
        logger.error(`Failed to send reply: ${error}`);
      });
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

    const errorContent = `There was an error executing this command!\n${errDetails}`;

    if (interaction.replied || interaction.deferred) {
      interaction
        .editReply({
          content: errorContent,
          components: [],
          embeds: [],
        })
        .catch((error) => {
          logger.error(`Failed to edit reply with error message: ${error}`);
        });
    } else {
      interaction
        .reply({
          content: errorContent,
          flags: [MessageFlagsBitField.Flags.Ephemeral],
        })
        .catch((error) => {
          logger.error(`Failed to send error reply: ${error}`);
        });
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
      flags: [MessageFlagsBitField.Flags.Ephemeral],
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
      flags: [MessageFlagsBitField.Flags.Ephemeral],
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
      flags: [MessageFlagsBitField.Flags.Ephemeral],
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
      flags: [MessageFlagsBitField.Flags.Ephemeral],
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
          await interaction
            .reply({
              content: `Command \`${interaction.commandName}\` not found.`,
              flags: [MessageFlagsBitField.Flags.Ephemeral],
            })
            .catch((error) => {
              logger.error(`Failed to reply to unknown command: ${error}`);
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
            flags: [MessageFlagsBitField.Flags.Ephemeral],
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
          await interaction
            .reply({
              content: "There was an error with this command implementation!",
              flags: [MessageFlagsBitField.Flags.Ephemeral],
            })
            .catch((error) => {
              logger.error(`Failed to send implementation error: ${error}`);
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
