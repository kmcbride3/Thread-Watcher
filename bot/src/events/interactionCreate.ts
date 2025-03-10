import {
  ActionRowBuilder,
  AutocompleteInteraction,
  BaseInteraction,
  ChatInputCommandInteraction,
  ColorResolvable,
  EmbedBuilder,
  Events,
  Interaction,
  MessageActionRowComponentBuilder,
  MessageFlagsBitField,
} from "discord.js";
import { commands } from "../bot";
import { ButtonInteractionQueue } from "../components/Button";
import { ModalInteractionQueue } from "../components/Modal";
import { StringSelectInteractionQueue } from "../components/StringSelect";
import { config, logger } from "../index";
import {
  BuildBaseEmbedFunction,
  Command,
  baseEmbedOptions,
  statusType,
} from "../interfaces/command";
import TwGenericComponent from "../interfaces/genericComponent";
import { ErrorSeverity, handleApiError, handleCommandError } from "../utilities/errorSystem";
import { rateLimitManager } from "../utilities/rateLimitManager";

/**
 * Creates a styled embed for command responses
 */
const buildBaseEmbed: BuildBaseEmbedFunction = (
  title: string,
  status: statusType = statusType.info,
  misc?: baseEmbedOptions
): EmbedBuilder => {
  // Use config styling if available, otherwise use fallback colors
  const style = config.style?.[status] || {
    colour:
      status === statusType.error
        ? "Red"
        : status === statusType.warning
          ? "Yellow"
          : status === statusType.success
            ? "Green"
            : "Blue",
    emoji: "",
  };

  const embed = new EmbedBuilder()
    .setColor(style.colour as ColorResolvable)
    .setTitle(`${style.emoji || ""} ${title}`.trim());

  if (misc?.description) embed.setDescription(misc.description);
  if (misc?.color) embed.setColor(misc.color);
  if (misc?.fields)
    embed.addFields(...misc.fields.map((field) => ({ ...field, value: field.value.toString() })));
  if (misc?.timestamp !== false) embed.setTimestamp();

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
    await rateLimitManager.waitForRateLimit(`interaction/response/${interaction.id}`);

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
      components: [...(options?.components || [])],
    };

    if (options?.ephemeral !== false) {
      responseOptions.flags = MessageFlagsBitField.Flags.Ephemeral;
    }

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
    logger.error(`sendResponse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Validate all gatekeeping requirements for a command
 */
function validateGatekeeping(
  interaction: ChatInputCommandInteraction,
  command: Command
): EmbedBuilder | null {
  const gatekeeping = command.gatekeeping;
  if (!gatekeeping) return null;

  // Check owner permissions
  if (gatekeeping.ownerOnly) {
    const owners = Array.isArray(config.owners) ? config.owners : [];

    if (!owners.includes(interaction.user.id)) {
      return buildBaseEmbed("Owner Only", statusType.error, {
        description: `Command \`${interaction.commandName}\` is restricted to owner${owners.length > 1 ? "s" : ""}.`,
      });
    }
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
    });
  }

  // All checks passed
  return null;
}

/**
 * Handle slash command interactions
 */
const handleCommandExecution = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  // Wait for rate limits first
  await rateLimitManager.waitForRateLimit(`commands/${interaction.commandName}`);

  // Get command from collection
  const command = commands.get(interaction.commandName);

  // Handle unknown command
  if (!command) {
    if (interaction.isRepliable()) {
      // Use proper flags pattern
      await interaction.reply({
        content: `Command \`${interaction.commandName}\` not found.`,
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
    }
    return;
  }

  if (!interaction.channel) {
    await sendResponse(
      interaction,
      buildBaseEmbed("Unknown Channel", statusType.error, {
        description:
          "Your interaction happened in an unknown channel.\n" +
          "**If this is a DM:** run it in a server. Thread-Watcher does not support DMs\n" +
          "**If this is not a DM:** something went wrong. Try again later.",
      })
    );
    return;
  }

  // Perform all gatekeeping checks
  const gatekeepingError = validateGatekeeping(interaction, command);
  if (gatekeepingError) {
    await sendResponse(interaction, gatekeepingError);
    return;
  }

  const wrappedBuildBaseEmbed: BuildBaseEmbedFunction = (title, status, options) => {
    const embed = buildBaseEmbed(title, status, options);

    if (!options?.noSend) {
      sendResponse(interaction, embed, options);
    }

    return embed;
  };

  try {
    await handleApiError(
      `Error executing command ${interaction.commandName}`,
      async () => {
        // Use run if available, otherwise fall back to execute for backwards compatibility
        if (command.run) {
          await command.run(interaction, wrappedBuildBaseEmbed);
        } else if (command.execute) {
          await command.execute(interaction, wrappedBuildBaseEmbed);
        } else {
          logger.error(`Command ${interaction.commandName} has neither run nor execute methods`);
          // Use proper flags pattern
          await interaction.reply({
            content: "There was an error with this command implementation!",
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        }
      },
      {
        retries: 2,
        retryDelay: 1000,
        context: `Command Execution: ${interaction.commandName}`,
        reportAtSeverity: ErrorSeverity.HIGH,
      }
    );
  } catch (error) {
    await handleCommandError(interaction, error, buildBaseEmbed, {
      errorTitle: "Command Error",
      errorDescription: `There was an error executing this command!\n${
        config.devServerInvite && config.devServerInvite !== "https://discord.gg/server"
          ? `If this error persists, please report it on the [support server](${config.devServerInvite}).`
          : "If this error persists, please report it on the repository issues."
      }`,
      context: `Command Execution: ${interaction.commandName}`,
    });
  }
};

/**
 * Handle autocompletion for commands
 */
const handleAutoComplete = async (interaction: AutocompleteInteraction): Promise<void> => {
  const command = commands.get(interaction.commandName);
  if (command?.autocomplete) {
    try {
      await rateLimitManager.waitForRateLimit(
        `autocomplete/${interaction.commandName}/${interaction.user.id}`
      );
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
  if (!interaction.customId) {
    logger.warn(`Interaction without customId received: ${interaction.id}`);
    return;
  }

  const component = queue.get(interaction.customId);
  if (component) {
    handleApiError(
      `Error processing interaction ${interaction.customId}`,
      async () => {
        if (interaction.user) {
          await rateLimitManager.waitForRateLimit(`component/${interaction.user.id}`);
        }
        await component.middleware(interaction);
      },
      {
        retries: 1,
        context: `Component Interaction: ${interaction.customId}`,
        reportAtSeverity: ErrorSeverity.MEDIUM,
      }
    ).catch((error) => {
      logger.error(`Failed to process component interaction: ${error}`);

      // Try to respond if possible
      if (
        "isRepliable" in interaction &&
        interaction.isRepliable() &&
        !("replied" in interaction && interaction.replied)
      ) {
        interaction
          .reply({
            content: "An error occurred while processing this interaction.",
            flags: [MessageFlagsBitField.Flags.Ephemeral], // Modern pattern
          })
          .catch((replyError) => {
            logger.error(`Failed to send error response: ${replyError}`);
          });
      }
    });
  } else if ("isRepliable" in interaction && interaction.isRepliable()) {
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
    try {
      if (interaction.user) {
        await rateLimitManager.waitForRateLimit(`interaction/${interaction.user.id}`);
      }

      if (interaction.isChatInputCommand()) {
        await handleCommandExecution(interaction);
      } else if (interaction.isAutocomplete()) {
        await handleAutoComplete(interaction);
      } else if (interaction.isButton()) {
        handleComponentInteraction(interaction, ButtonInteractionQueue);
      } else if (interaction.isModalSubmit()) {
        handleComponentInteraction(interaction, ModalInteractionQueue);
      } else if (interaction.isStringSelectMenu()) {
        handleComponentInteraction(interaction, StringSelectInteractionQueue);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Unhandled error in interaction handler: ${errorMessage}`);
    }
  },
};
