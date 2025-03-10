import { AttachmentBuilder, ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db } from "../../index";
import { Command, statusType } from "../../interfaces/command";
import { ChannelData, ThreadData } from "../../interfaces/database";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { rateLimitManager } from "../../utilities/rateLimitManager";

/**
 * Escape special characters for CSV field output
 */
function escapeCSVField(value: unknown): string {
  let stringValue: string;

  if (value === null || value === undefined) {
    stringValue = "";
  } else if (Array.isArray(value)) {
    stringValue = value.filter(Boolean).join(",");
  } else if (typeof value === "object") {
    try {
      stringValue = JSON.stringify(value);
    } catch {
      stringValue = "[Object]";
    }
  } else {
    stringValue = String(value);
  }

  // Escape CSV special characters
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

const THREAD_COLUMNS = ["id", "server", "watching", "dueArchive"] as const;
const CHANNEL_COLUMNS = ["id", "server", "regex", "roles", "tags"] as const;

// Type-safe property access for thread data
function getThreadProperty(thread: ThreadData, key: (typeof THREAD_COLUMNS)[number]): unknown {
  switch (key) {
    case "id":
      return thread.id;
    case "server":
      return thread.server;
    case "watching":
      return thread.watching;
    case "dueArchive":
      return thread.dueArchive;
    default:
      return "";
  }
}

// Type-safe property access for channel data
function getChannelProperty(channel: ChannelData, key: (typeof CHANNEL_COLUMNS)[number]): unknown {
  switch (key) {
    case "id":
      return channel.id;
    case "server":
      return channel.server;
    case "regex":
      return channel.regex;
    case "roles":
      return channel.roles;
    case "tags":
      return channel.tags;
    default:
      return "";
  }
}

/**
 * Convert thread data array to CSV format
 */
function threadsToCSV(threads: ThreadData[]): string {
  if (!threads || threads.length === 0) return "";

  const headers = ["Thread ID", "Server ID", "Watching", "Due Archive"];

  const headerRow = headers.map(escapeCSVField).join(",");

  const rows = threads.map((thread) =>
    THREAD_COLUMNS.map((column) => escapeCSVField(getThreadProperty(thread, column))).join(",")
  );

  return [headerRow, ...rows].join("\n");
}

/**
 * Convert channel data array to CSV format
 */
function channelsToCSV(channels: ChannelData[]): string {
  if (!channels || channels.length === 0) return "";

  const headers = ["Channel ID", "Server ID", "Regex", "Roles", "Tags"];

  const headerRow = headers.map(escapeCSVField).join(",");

  const rows = channels.map((channel) =>
    CHANNEL_COLUMNS.map((column) => escapeCSVField(getChannelProperty(channel, column))).join(",")
  );

  return [headerRow, ...rows].join("\n");
}

const exportCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed): Promise<void> => {
    try {
      await interaction.deferReply({ ephemeral: true });

      await rateLimitManager.waitForRateLimit(`admin/export/${interaction.user.id}`);

      const guildId = interaction.options.getString("guild");

      if (!guildId) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Error", statusType.error, {
              description: "No guild ID provided",
            }),
          ],
        });
        return;
      }

      const { threads, channels, guildName } = await handleApiError(
        "Failed to fetch guild data",
        async () => {
          const [threadData, channelData] = await Promise.all([
            db.getThreads(guildId),
            db.getChannels(guildId),
          ]);

          let name = guildId;
          try {
            const guild = await interaction.client.guilds.fetch(guildId);
            name = guild.name;
          } catch {
            // Keep ID as fallback if guild not found
          }

          return {
            threads: threadData,
            channels: channelData,
            guildName: name,
          };
        },
        {
          context: "Export Command - Data Fetching",
          reportAtSeverity: ErrorSeverity.MEDIUM,
        }
      );

      const files: AttachmentBuilder[] = [];

      const dateStamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      const safeGuildName = guildName.replace(/[^a-z0-9]/gi, "-").toLowerCase();

      if (threads && threads.length > 0) {
        const threadsCSV = threadsToCSV(threads);

        const threadsBuffer = Buffer.from(threadsCSV, "utf-8");
        files.push(
          new AttachmentBuilder(threadsBuffer, {
            name: `${safeGuildName}-threads-${dateStamp}.csv`,
            description: `Thread data for ${guildName}`,
          })
        );
      }

      if (channels && channels.length > 0) {
        const channelsCSV = channelsToCSV(channels);

        const channelsBuffer = Buffer.from(channelsCSV, "utf-8");
        files.push(
          new AttachmentBuilder(channelsBuffer, {
            name: `${safeGuildName}-channels-${dateStamp}.csv`,
            description: `Channel data for ${guildName}`,
          })
        );
      }

      if (files.length === 0) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Not found", statusType.error, {
              description: `Found no data from guild "${guildName}" (${guildId})`,
            }),
          ],
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          buildBaseEmbed("Data export", statusType.success, {
            description: `Here's all the data saved from guild ${guildName}`,
            fields: [
              { name: "Guild ID", value: guildId, inline: true },
              { name: "Thread Count", value: String(threads?.length || 0), inline: true },
              { name: "Channel Count", value: String(channels?.length || 0), inline: true },
              { name: "Export Date", value: new Date().toISOString() },
            ],
          }),
        ],
        files,
      });
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Export Failed",
        errorDescription: "Failed to export guild data. Please check the guild ID and try again.",
        context: "Export Command",
      });
    }
  },
  gatekeeping: {
    ownerOnly: true,
    devServerOnly: true,
  },
  data: new SlashCommandBuilder()
    .setName("export")
    .setDescription("Export saved data pertaining to selected guild")
    .addStringOption((o) =>
      o.setName("guild").setDescription("What guild you want to get data from").setRequired(true)
    ),
};

export default exportCommand;
