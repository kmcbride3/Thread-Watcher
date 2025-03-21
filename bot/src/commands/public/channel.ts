import {
  ChatInputCommandInteraction,
  MessageFlagsBitField,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "../../interfaces/command";
import { SERVICE_KEYS, serviceRegistry } from "../../services";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { StatusType } from "../../utilities/logger";
import { rateLimitManager } from "../../utilities/rateLimitManager";
import { THREAD_RELATED_CHANNEL_TYPES } from "../../utilities/threadUtils";

const channelCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
    try {
      const channel = interaction.options.getChannel("channel");
      if (!channel) {
        await interaction.reply({
          embeds: [
            buildBaseEmbed("Error", "error" as StatusType, {
              description: "Channel not specified",
            }),
          ],
          flags: [MessageFlagsBitField.Flags.Ephemeral],
        });
        return;
      }

      await interaction.deferReply({
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });

      await rateLimitManager.waitForRateLimit(`guilds/${interaction.guildId}/channels`);
      const command = interaction.options.getSubcommand(true);

      // Get database from service registry with proper error handling
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Service unavailable", "error" as StatusType, {
              description: "Database service is currently unavailable. Please try again later.",
            }),
          ],
        });
        return;
      }

      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE, {
        errorContext: `Channel Command - ${command}`,
      });

      await handleApiError(
        "Failed to fetch channel data",
        async () => {
          const alrExists = (await db.getChannels(interaction.guildId ?? "")).find(
            (t) => t.id === channel.id
          );

          if (command === "add") {
            if (alrExists) {
              await interaction.editReply({
                embeds: [
                  buildBaseEmbed("Already watched", "warning" as StatusType, {
                    description:
                      "That channel is already watched. Remove it with `/channel remove`",
                  }),
                ],
              });
              return;
            }

            await db.insertChannel({
              server: interaction.guildId ?? "",
              id: channel.id,
              regex: "",
              roles: [],
              tags: [],
            });
            await interaction.editReply({
              embeds: [
                buildBaseEmbed("Added channel", "success" as StatusType, {
                  description: `Channel <#${channel.id}> has been added to the watchlist`,
                }),
              ],
            });
          } else {
            await db.deleteChannel(channel.id);
            await interaction.editReply({
              embeds: [
                buildBaseEmbed("Removed channel", "success" as StatusType, {
                  description: `Channel <#${channel.id}> has been removed from the watchlist`,
                }),
              ],
            });
          }
        },
        {
          context: `Channel Command - ${command}`,
          reportAtSeverity: ErrorSeverity.MEDIUM,
        }
      );
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Channel Action Failed",
        errorDescription: "Failed to process channel action. Please try again later.",
        context: "Channel command",
      });
    }
  },
  gatekeeping: {
    userPermissions: [PermissionFlagsBits.ManageThreads],
    ownerOnly: false,
    devServerOnly: false,
  },
  data: new SlashCommandBuilder()
    .setName("channel")
    .setDescription("add and remove channel watches")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("add a channel to the watchlist")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("the channel or category you want to add")
            .addChannelTypes(...THREAD_RELATED_CHANNEL_TYPES)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("remove a channel from the watchlist")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("the channel or category you want to remove")
            .addChannelTypes(...THREAD_RELATED_CHANNEL_TYPES)
            .setRequired(true)
        )
    ),
};

export default channelCommand;
