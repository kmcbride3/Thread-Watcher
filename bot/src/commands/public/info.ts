import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  version as djsVersion,
} from "discord.js";
import { version } from "../../../package.json";
import { Command } from "../../interfaces/command";
import { SERVICE_KEYS, serviceRegistry } from "../../services";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { formatDuration, formatNumber } from "../../utilities/formatUtils";
import { rateLimitManager } from "../../utilities/rateLimitManager";

const infoCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
    try {
      // Immediately defer the reply to prevent interaction timeout
      await interaction.deferReply();

      await rateLimitManager.waitForRateLimit("commands/info");

      // Get client from service registry
      const client = serviceRegistry.get(SERVICE_KEYS.CLIENT, {
        errorContext: "Info Command - Client Access",
        reportErrors: true,
      });

      const db = serviceRegistry.get(SERVICE_KEYS.DATABASE, {
        errorContext: "Info Command - Database Access",
        reportErrors: true,
      });

      // Use the formatDuration utility instead of custom function
      const uptime = formatDuration(client.uptime || 0);

      const [threadCount, channelCount] = await handleApiError(
        "Failed to fetch thread and channel counts",
        async () => {
          return Promise.all([db.getNumberOfThreads(), db.getNumberOfChannels()]);
        },
        {
          context: "Info Command - Database Stats",
          reportAtSeverity: ErrorSeverity.LOW,
        }
      );

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle("Thread Watcher Info")
        .addFields(
          { name: "Bot Version", value: version || "Unknown", inline: true },
          { name: "Discord.js", value: `v${djsVersion}`, inline: true },
          { name: "Node.js", value: `${process.version}`, inline: true },
          { name: "Uptime", value: uptime, inline: true },
          { name: "Shard ID", value: `${client.shard?.ids[0] ?? 0}`, inline: true },
          // Use formatNumber for numerical values
          { name: "Servers", value: formatNumber(client.guilds.cache.size), inline: true },
          { name: "Threads Watched", value: formatNumber(threadCount), inline: true },
          { name: "Channels Watched", value: formatNumber(channelCount), inline: true }
        )
        .setFooter({ text: `${Date.now().toLocaleString("en-CA")}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Info Command Failed",
        errorDescription: "There was an error gathering the bot information.",
        context: "Info Command",
        reportAtSeverity: ErrorSeverity.LOW,
      });
    }
  },
  data: new SlashCommandBuilder().setName("info").setDescription("Show information about this bot"),
};

export default infoCommand;
