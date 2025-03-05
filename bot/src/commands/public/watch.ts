import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadChannel,
  DiscordAPIError,
  MessageFlagsBitField,
} from "discord.js";
import {
  addThread,
  dueArchiveTimestamp,
  removeThread,
  setArchive,
} from "../../utilities/threadActions";
import { BuildBaseEmbedFunction, Command, statusType } from "../../interfaces/command";
import { logger } from "../../index";
import { threads } from "../../bot";

interface ThreadWatchOptions {
  channel_types: number[];
  description: string;
  name: string;
  type: number;
}

const watch: Command = {
  run: async (
    interaction: ChatInputCommandInteraction,
    buildBaseEmbed: BuildBaseEmbedFunction
  ): Promise<void> => {
    await interaction.deferReply({
      flags: [MessageFlagsBitField.Flags.Ephemeral],
    });
    const thread: ThreadChannel | null =
      (interaction.options.getChannel("thread") as ThreadChannel) ||
      (interaction.channel as ThreadChannel);
    if (!thread) {
      const embed = buildBaseEmbed("Something went wrong", statusType.error, {
        description: "for forum posts you __need__ to pass the post with the `thread` option.",
      });
      await interaction.reply({
        embeds: [embed],
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
      return;
    }
    if (!thread?.type || ![10, 11, 12].includes(thread?.type)) {
      const embed = buildBaseEmbed("Cannot watch that!", statusType.error, {
        description: `<#${thread?.id}> is not a thread or forum post.`,
      });
      await interaction.reply({
        embeds: [embed],
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
      return;
    }

    if (!(thread instanceof ThreadChannel)) return;

    if (threads.has(thread.id) && threads.get(thread.id)?.watching) {
      removeThread(thread.id)
        .then((): void => {
          buildBaseEmbed("Unwatched thread", statusType.success, {
            showAuthor: true,
            description: `Bot will no longer keep <#${thread.id}> active`,
          });
        })
        .catch(async (): Promise<void> => {
          const embed = buildBaseEmbed("Failed to unwatch thread", statusType.error, {
            description: `Bot failed to unwatch <#${thread.id}>`,
          });
          await interaction.reply({
            embeds: [embed],
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        });
    } else {
      addThread(
        thread.id,
        dueArchiveTimestamp(thread.autoArchiveDuration || 0, thread.lastMessage?.createdAt),
        interaction.guildId || ""
      )
        .then((): void => {
          if (!thread.archived || thread.unarchivable) {
            buildBaseEmbed("Watched thread", statusType.success, {
              showAuthor: true,
              description: `Bot will keep <#${thread.id}> active`,
            });
          } else {
            buildBaseEmbed("Watched thread but...", statusType.warning, {
              showAuthor: true,
              description: `Bot has added <#${thread.id}> to the watchlist.\n\nHowever, the thread will __**NOT**__ be kept active as the bot has insufficient permissions for the thread`,
            });
          }

          if (thread.archived && thread.unarchivable) {
            setArchive(thread, false).catch((err: DiscordAPIError): void => {
              logger.warn(`Failed to unarchive thread ${thread.id}: ${err}`);
            });
          }
        })
        .catch(async (): Promise<void> => {
          const embed = buildBaseEmbed("Failed to watch thread", statusType.error, {
            description: `Bot failed to watch <#${thread.id}>`,
          });
          await interaction.reply({
            embeds: [embed],
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        });
    }
  },
  gatekeeping: {
    userPermissions: [PermissionFlagsBits.ManageThreads],
    ownerOnly: false,
    devServerOnly: false,
  },
  data: new SlashCommandBuilder().setName("watch").setDescription("watch or unwatch a thread"),
  externalOptions: [
    {
      channel_types: [10, 11, 12, 16],
      description: "thread to watch or unwatch",
      name: "thread",
      type: 7,
    } as ThreadWatchOptions,
  ],
};

export default watch;
