import {
  ChatInputCommandInteraction,
  PermissionsBitField,
  SlashCommandBuilder,
  MessageFlagsBitField,
} from "discord.js";
import { Command, statusType } from "../../interfaces/command";

const auto: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
    const embed = buildBaseEmbed("Depreciated", statusType.warning, {
      description: "The functionality of this command has been moved to `/batch`",
    });
    await interaction.reply({
      embeds: [embed],
      flags: [MessageFlagsBitField.Flags.Ephemeral],
    });
  },
  gatekeeping: {
    userPermissions: [PermissionsBitField.Flags.ManageThreads],
    ownerOnly: false,
    devServerOnly: false,
  },
  data: new SlashCommandBuilder()
    .setName("auto")
    .setDescription("automatically watch created threads in a channel or forum"),
  externalOptions: [
    {
      channel_types: [15, 5, 0],
      description: "channel to automatically watch threads in",
      name: "channel",
      type: 7,
    },
    {
      description: "advanced filters",
      name: "advanced",
      type: 5,
      required: false,
    },
  ],
};

export default auto;
