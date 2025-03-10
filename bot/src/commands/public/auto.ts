import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  MessageFlagsBitField,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { Command, statusType } from "../../interfaces/command";
import { handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { rateLimitManager } from "../../utilities/rateLimitManager";
import { THREAD_CAPABLE_CHANNEL_TYPES } from "../../utilities/threadUtils";

const auto: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
    try {
      await rateLimitManager.waitForRateLimit(`commands/${interaction.guildId}/auto`);

      await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] });

      await handleApiError(
        "Failed to process auto command",
        async () => {
          const embed = buildBaseEmbed("Deprecated Command", statusType.warning, {
            description: "The functionality of this command has been moved to `/batch`",
          });

          await interaction.editReply({
            embeds: [embed],
          });
        },
        { context: "Auto Command - Redirection" }
      );
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Command Failed",
        errorDescription:
          "There was an error processing the command. Please try using `/batch` instead.",
        context: "Auto Command",
      });
    }
  },
  gatekeeping: {
    userPermissions: [PermissionFlagsBits.ManageThreads],
    ownerOnly: false,
    devServerOnly: false,
  },
  data: new SlashCommandBuilder()
    .setName("auto")
    .setDescription("automatically watch created threads in a channel or forum"),
  externalOptions: [
    {
      channel_types: THREAD_CAPABLE_CHANNEL_TYPES,
      description: "channel to automatically watch threads in",
      name: "channel",
      type: ApplicationCommandOptionType.Channel,
    },
    {
      description: "advanced filters",
      name: "advanced",
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
  ],
};

export default auto;
