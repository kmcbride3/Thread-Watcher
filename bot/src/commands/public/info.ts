import {
  ChatInputCommandInteraction,
  version as djsVersion,
  EmbedBuilder,
  MessageFlagsBitField,
  SlashCommandBuilder,
  time,
  TimestampStyles,
} from "discord.js";
import { version } from "../../../package.json";
import { threads } from "../../bot";
import { config } from "../../index";
import { Command, statusType } from "../../interfaces/command";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { formatDuration, formatFileSize } from "../../utilities/formatUtils";
import { rateLimitManager } from "../../utilities/rateLimitManager";

const infoCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
    try {
      await rateLimitManager.waitForRateLimit("commands/info");

      await interaction.deferReply({
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });

      const embeds: EmbedBuilder[] = [];

      await handleApiError(
        "Failed to collect bot statistics",
        async () => {
          let guildCount = interaction.client.guilds.cache.size || 0;

          if (interaction.client.shard) {
            const shardGuildCounts = (await interaction.client.shard.fetchClientValues(
              "guilds.cache.size"
            )) as number[];
            if (Array.isArray(shardGuildCounts)) {
              guildCount = shardGuildCounts.reduce(
                (acc, count) => acc + (typeof count === "number" ? count : 0),
                0
              );
            }
          }

          const processStarted = Math.floor(Date.now() / 1000 - process.uptime());

          // Use Discord timestamp format for nicer display
          const startTimeFormatted = time(
            new Date(processStarted * 1000),
            TimestampStyles.RelativeTime
          );

          // Use our new formatters for nicer output
          const memoryUsage = process.memoryUsage();
          const memoryUsedFormatted = formatFileSize(memoryUsage.rss);
          const uptimeFormatted = formatDuration(interaction.client.uptime || 0);

          const botInfoEmbed = buildBaseEmbed(
            `About ${interaction.client.user?.tag || "Thread Watcher"}`,
            statusType.info,
            {
              noSend: true,
              fields: [
                {
                  name: "Stats",
                  value: `🤙 Bot is in \`${guildCount}\` servers\n👁 Bot is watching \`${threads.size}\` threads in this shard\n🤓 Average threads watched per server in this shard is \`${(threads.size / interaction.client.guilds.cache.size).toFixed(2)}\` threads`,
                },
                {
                  name: "Shard",
                  value: `🥛 You are in shard \`${interaction.guild?.shardId}\`\n👲 There are \`${interaction.client.guilds.cache.size}\` guilds in this shard\n⏱ This shard started ${startTimeFormatted}`,
                },
                {
                  name: "🚑 Get support",
                  value: `To get help with this instance of thread-watcher you can join the [**support server**](${config.devServerInvite})`,
                },
                {
                  name: "Version Info",
                  value: `Bot: \`${version}\`\nDiscord.js: \`${djsVersion}\`\nNode.js: \`${process.version}\``,
                  inline: true,
                },
                {
                  name: "System",
                  value: `Uptime: ${uptimeFormatted}\nMemory: ${memoryUsedFormatted}`,
                  inline: true,
                },
              ],
            }
          );
          embeds.push(botInfoEmbed);

          const devEmbed = buildBaseEmbed("About the development", statusType.info, {
            noSend: true,
            fields: [
              {
                name: "Source code",
                value:
                  "Thread-Watcher is fully open source. You can view the source code [here](https://github.com/ffamilyfriendly/Thread-Watcher/) and get help with self-hosting the bot [on the wiki](https://docs.threadwatcher.xyz/hosting/start)",
              },
              {
                name: "Credits",
                value:
                  "[Thread-Watcher](https://threadwatcher.xyz) is being developed by [**FamilyFriendly**](https://familyfriendly.xyz) using the [discord.js](https://discord.js.org/#/) library.\nIt uses the libraries [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) by [**Joshua Wise**](https://github.com/JoshuaWise) and [mysql](https://www.npmjs.com/package/mysql) created by [**the contributors of mysqljs/mysql**](https://github.com/mysqljs/mysql/graphs/contributors) to store data.\nIt also uses the logging library [log75](https://www.npmjs.com/package/log75) created by [**wait what**](https://waitwhat.sh/)",
              },
              {
                name: "Support the Bot",
                value:
                  "Want to help keep Thread-Watcher free? You can find ways to donate [here](https://threadwatcher.xyz/donate)\nIf you cant donate (I get it) I'd very much appreciate an honest review on [top.gg](https://top.gg/bot/870715447136366662#reviews)",
              },
            ],
          });
          embeds.push(devEmbed);
        },
        {
          context: "Info Command - Statistics Collection",
          reportAtSeverity: ErrorSeverity.LOW,
        }
      );

      await interaction.editReply({ embeds });
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Information Unavailable",
        errorDescription: "Failed to retrieve bot information. Please try again later.",
        context: "Info Command",
      });
    }
  },
  data: new SlashCommandBuilder().setName("info").setDescription("Get information about the bot"),
};

export default infoCommand;
