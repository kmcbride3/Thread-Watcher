import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  DiscordAPIError,
  MessageFlagsBitField,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadChannel,
} from "discord.js";
import { threads } from "../../bot";
import { logger } from "../../index";
import { Command, statusType } from "../../interfaces/command";
import { EmbedBuilderFunction } from "../../utilities/embedUtils";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { formatArchiveDuration } from "../../utilities/formatUtils";
import { rateLimitManager } from "../../utilities/rateLimitManager";
import {
  addThread,
  dueArchiveTimestamp,
  removeThread,
  setArchive,
} from "../../utilities/threadActions";
import {
  THREAD_CHANNEL_TYPES,
  createThreadValidationErrorHandler,
  validateThread,
} from "../../utilities/threadUtils";

interface ThreadWatchOptions {
  channel_types: number[];
  description: string;
  name: string;
  type: number;
}

const watchCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed: EmbedBuilderFunction) => {
    try {
      await interaction.deferReply({
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });

      await handleApiError(
        "Rate limit check failed",
        async () =>
          await rateLimitManager.waitForRateLimit(`commands/${interaction.guildId}/watch`),
        { context: "Watch Command - Rate Limit Check", reportAtSeverity: ErrorSeverity.LOW }
      );

      const threadOption = interaction.options.getChannel("thread") as ThreadChannel | null;
      const thread = threadOption || (interaction.channel as ThreadChannel | null);

      const errorHandler = createThreadValidationErrorHandler(interaction, buildBaseEmbed);
      if (!validateThread(thread, errorHandler)) {
        return;
      }

      const isThreadWatched = threads.has(thread.id) && Boolean(threads.get(thread.id)?.watching);

      if (isThreadWatched) {
        await handleUnwatchThread(thread, interaction, buildBaseEmbed);
      } else {
        await handleWatchThread(thread, interaction, buildBaseEmbed);
      }
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Watch Command Failed",
        errorDescription: "An unexpected error occurred while processing the thread watch command.",
        context: "Watch Command",
      });
    }
  },
  gatekeeping: {
    userPermissions: [PermissionFlagsBits.ManageThreads],
    ownerOnly: false,
    devServerOnly: false,
  },
  data: new SlashCommandBuilder().setName("watch").setDescription("Watch or unwatch a thread"),
  externalOptions: [
    {
      channel_types: [...THREAD_CHANNEL_TYPES, ChannelType.GuildMedia],
      description: "thread to watch or unwatch",
      name: "thread",
      type: ApplicationCommandOptionType.Channel,
    } as ThreadWatchOptions,
  ],
};

export default watchCommand;

/**
 * Handle unwatching a thread
 */
async function handleUnwatchThread(
  thread: ThreadChannel,
  interaction: ChatInputCommandInteraction,
  buildBaseEmbed: EmbedBuilderFunction
): Promise<void> {
  await handleApiError(
    "Failed to remove thread from watch list",
    async () => {
      await removeThread(thread.id);

      await interaction.editReply({
        embeds: [
          buildBaseEmbed("Unwatched thread", statusType.success, {
            showAuthor: true,
            description: `Bot will no longer keep <#${thread.id}> active`,
            fields: [
              {
                name: "Thread Name",
                value: thread.name,
                inline: true,
              },
            ],
          }),
        ],
      });
    },
    {
      context: "Watch Command - Unwatch Thread",
      reportAtSeverity: ErrorSeverity.MEDIUM,
    }
  );
}

/**
 * Handle watching a thread
 */
async function handleWatchThread(
  thread: ThreadChannel,
  interaction: ChatInputCommandInteraction,
  buildBaseEmbed: EmbedBuilderFunction
): Promise<void> {
  await handleApiError(
    "Failed to add thread to watch list",
    async () => {
      const dueTimestamp =
        dueArchiveTimestamp(thread.autoArchiveDuration ?? 0, thread.lastMessage?.createdAt) ??
        Date.now() + 3600000; // Default to 1 hour if calculation fails

      await addThread(thread.id, dueTimestamp, thread.guildId);

      const canManageThread =
        thread.manageable &&
        !thread.locked &&
        interaction.guild?.members.me?.permissions.has(PermissionFlagsBits.ManageThreads);

      if (canManageThread) {
        const archiveDuration = formatArchiveDuration(thread.autoArchiveDuration ?? 1440);

        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Watched thread", statusType.success, {
              showAuthor: true,
              description: `Bot will keep <#${thread.id}> active`,
              fields: [
                {
                  name: "Auto-archive",
                  value: `Thread set to archive after ${archiveDuration} of inactivity`,
                  inline: true,
                },
              ],
            }),
          ],
        });
      } else {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Watched thread but...", statusType.warning, {
              showAuthor: true,
              description: `Bot has added <#${thread.id}> to the watchlist.\n\nHowever, the thread will __**NOT**__ be kept active as the bot has insufficient permissions for the thread`,
            }),
          ],
        });
      }

      if (thread.archived && thread.unarchivable) {
        try {
          await setArchive(thread, 10080);
        } catch (err: unknown) {
          if (err instanceof DiscordAPIError) {
            const errorCode = err.code;
            if (errorCode === 50013) {
              // Missing Permissions
              logger.warn(`Missing permissions to unarchive thread ${thread.id}`);
            } else if (errorCode === 50001) {
              // Missing Access
              logger.warn(`Missing access to unarchive thread ${thread.id}`);
            } else {
              logger.warn(`Failed to unarchive thread ${thread.id}: [${errorCode}] ${err.message}`);
            }
          }
        }
      }
    },
    {
      context: "Watch Command - Watch Thread",
      reportAtSeverity: ErrorSeverity.MEDIUM,
    }
  );
}
