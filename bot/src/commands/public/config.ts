import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { botSettings } from "../../bot";
import { Command, statusType } from "../../interfaces/command";
import { EmbedBuilderFunction } from "../../utilities/embedUtils";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { rateLimitManager } from "../../utilities/rateLimitManager";

const configCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, embedBuilder: EmbedBuilderFunction) => {
    try {
      await interaction.deferReply();

      const settingGroup = interaction.options.getSubcommandGroup(true);
      const settingAction = interaction.options.getSubcommand(true);

      // Check for rate limits before proceeding
      const settingsRoute = `guilds/${interaction.guildId}/settings`;
      await rateLimitManager.waitForRateLimit(settingsRoute);

      let responseEmbed: EmbedBuilder;

      if (settingGroup === "logs") {
        responseEmbed = await handleApiError(
          "Failed to manage log settings",
          async () => await handleLogsConfig(interaction, settingAction, embedBuilder),
          {
            context: "Config Command - Logs Settings",
            reportAtSeverity: ErrorSeverity.MEDIUM,
          }
        );
      } else if (settingGroup === "behaviour") {
        responseEmbed = await handleApiError(
          "Failed to manage behavior settings",
          async () => await handleBehaviourConfig(interaction, settingAction, embedBuilder),
          {
            context: "Config Command - Behavior Settings",
            reportAtSeverity: ErrorSeverity.MEDIUM,
          }
        );
      } else {
        responseEmbed = embedBuilder("Invalid Settings", statusType.error, {
          description: "Unknown settings group requested",
        });
      }

      await interaction.editReply({ embeds: [responseEmbed] });
    } catch (error) {
      await handleCommandError(interaction, error, embedBuilder, {
        errorTitle: "Settings Update Failed",
        errorDescription: "An error occurred while updating server settings",
        context: "Config Command",
        reportAtSeverity: ErrorSeverity.MEDIUM,
      });
    }
  },
  gatekeeping: {
    userPermissions: [PermissionFlagsBits.ManageThreads],
    ownerOnly: false,
    devServerOnly: false,
  },
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("configure settings")
    .addSubcommandGroup((group) =>
      group
        .setName("logs")
        .setDescription("Where thread-watcher will send logs")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("set")
            .setDescription("select a new value")
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("the channel logs will be sent in")
                .addChannelTypes(
                  ChannelType.GuildText,
                  ChannelType.PublicThread,
                  ChannelType.PrivateThread
                )
                .setRequired(true)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand.setName("reset").setDescription("will reset the value to the default")
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("behaviour")
        .setDescription("how thread-watcher will treat threads")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("set")
            .setDescription("select a new value")
            .addStringOption((option) =>
              option
                .setName("behaviour")
                .setDescription("how thread-watcher will treat threads")
                .setRequired(true)
                .setChoices(
                  {
                    name: "un-archive and keep active (default)",
                    value: "DEFAULT",
                  },
                  {
                    name: "un-archive only",
                    value: "UNARCHIVE_ONLY",
                  }
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand.setName("reset").setDescription("will reset the value to the default")
        )
    ),
};

/**
 * Handle logs configuration subcommands
 * @param interaction The interaction that triggered this command
 * @param action The action to perform (set or reset)
 * @param embedBuilder The embed builder to use for responses
 * @returns An EmbedBuilder instance with the response
 */
async function handleLogsConfig(
  interaction: ChatInputCommandInteraction,
  action: string,
  embedBuilder: EmbedBuilderFunction
): Promise<EmbedBuilder> {
  if (!botSettings) {
    throw new Error("Bot settings service is unavailable");
  }

  const guildId = interaction.guildId ?? "";

  if (action === "reset") {
    return await handleApiError(
      "Failed to reset log channel configuration",
      async () => {
        if (!botSettings) {
          throw new Error("Bot settings service is unavailable");
        }
        await botSettings.removeSetting(guildId, "LOGCHANNEL");
        return embedBuilder("Configuration Updated", statusType.success, {
          description: "Log channel has been reset to default value",
        });
      },
      {
        context: "Config Command - Reset Log Channel",
        reportAtSeverity: ErrorSeverity.MEDIUM,
      }
    );
  } else if (action === "set") {
    const selectedChannel = interaction.options.getChannel("channel", true);

    return await handleApiError(
      "Failed to update log channel configuration",
      async () => {
        if (!botSettings) {
          throw new Error("Bot settings service is unavailable");
        }
        await botSettings.setSetting(guildId, "LOGCHANNEL", selectedChannel.id);
        return embedBuilder("Configuration Updated", statusType.success, {
          description: `Log channel has been set to <#${selectedChannel.id}>`,
        });
      },
      {
        context: "Config Command - Set Log Channel",
        reportAtSeverity: ErrorSeverity.MEDIUM,
      }
    );
  } else {
    return embedBuilder("Invalid Action", statusType.error, {
      description: "Unknown log configuration action requested",
    });
  }
}

/**
 * Handle behaviour configuration subcommands
 * @param interaction The interaction that triggered this command
 */
async function handleBehaviourConfig(
  interaction: ChatInputCommandInteraction,
  action: string,
  embedBuilder: EmbedBuilderFunction
): Promise<EmbedBuilder> {
  if (!botSettings) {
    throw new Error("Bot settings service is unavailable");
  }

  const guildId = interaction.guildId ?? "";

  if (action === "reset") {
    return await handleApiError(
      "Failed to reset thread behavior configuration",
      async () => {
        await botSettings?.removeSetting(guildId, "BEHAVIOUR");
        return embedBuilder("Configuration Updated", statusType.success, {
          description: "Thread behavior has been reset to default value",
        });
      },
      {
        context: "Config Command - Reset Behavior",
        reportAtSeverity: ErrorSeverity.MEDIUM,
      }
    );
  } else if (action === "set") {
    const selectedBehavior = interaction.options.getString("behaviour", true);
    const behaviorDescription =
      selectedBehavior === "DEFAULT" ? "un-archive and keep active" : "un-archive only";

    return await handleApiError(
      "Failed to update thread behavior configuration",
      async () => {
        await botSettings?.setSetting(guildId, "BEHAVIOUR", selectedBehavior);
        return embedBuilder("Configuration Updated", statusType.success, {
          description: `Thread behavior has been set to "${behaviorDescription}"`,
        });
      },
      {
        context: "Config Command - Set Behavior",
        reportAtSeverity: ErrorSeverity.MEDIUM,
      }
    );
  } else {
    return embedBuilder("Invalid Action", statusType.error, {
      description: "Unknown behavior configuration action requested",
    });
  }
}

export default configCommand;
