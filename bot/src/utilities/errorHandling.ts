import { CommandInteraction, MessageFlagsBitField } from "discord.js";
import { logger } from "../index";
import { statusType } from "../interfaces/command";
import { EmbedBuilderFunction } from "./embedUtils";

/**
 * Safely respond to an interaction with an error message
 */
export async function safeReplyWithError(
  interaction: CommandInteraction,
  error: unknown,
  embedBuilder: EmbedBuilderFunction,
  errorTitle = "Error",
  errorDescription = "An unexpected error occurred while processing your request."
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error(`Command error: ${errorMessage}`);

  try {
    const errorEmbed = embedBuilder(errorTitle, statusType.error, {
      description: errorDescription,
    });

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [errorEmbed],
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
    } else if (interaction.deferred) {
      await interaction.editReply({
        embeds: [errorEmbed],
      });
    }
  } catch (replyError) {
    logger.error(
      `Failed to send error response: ${
        replyError instanceof Error ? replyError.message : String(replyError)
      }`
    );
  }
}

/**
 * Create a standardized wrapper for command execution
 */
export function createCommandWrapper<T extends CommandInteraction>(
  executeFunction: (interaction: T, ...args: unknown[]) => Promise<void>,
  embedBuilder: EmbedBuilderFunction
): (interaction: T, ...args: unknown[]) => Promise<void> {
  return async (interaction: T, ...args: unknown[]): Promise<void> => {
    try {
      await executeFunction(interaction, ...args);
    } catch (error) {
      await safeReplyWithError(interaction, error, embedBuilder);
    }
  };
}
