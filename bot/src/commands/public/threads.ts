import { ChatInputCommandInteraction, MessageFlagsBitField, SlashCommandBuilder } from "discord.js";
import { Command, statusType } from "../../interfaces/command";
import { handleCommandError } from "../../utilities/errorSystem";
import { formatCodeBlock } from "../../utilities/formatUtils";
import { rateLimitManager } from "../../utilities/rateLimitManager";

const threadsCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
    try {
      // Apply rate limiting
      await rateLimitManager.waitForRateLimit("commands/threads");

      // Respond with ephemeral message for the redirect notice
      await interaction.reply({
        embeds: [
          buildBaseEmbed("Command Moved", statusType.info, {
            description: `The ${formatCodeBlock("/threads", "fix")} command has been moved to ${formatCodeBlock("/list", "fix")}`,
            fields: [
              {
                name: "How to use the new command",
                value: `Try using ${formatCodeBlock("/list show:threads", "bash")} to see your watched threads`,
              },
            ],
          }),
        ],
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
    } catch (error) {
      // Use standardized error handling
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Command Error",
        errorDescription: "Unable to process this command. Please try again later.",
        context: "Threads Command - Redirect Notice",
      });
    }
  },
  data: new SlashCommandBuilder()
    .setName("threads")
    .setDescription("Deprecated - Use /list instead"),
};

export default threadsCommand;
