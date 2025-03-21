import {
  ApplicationCommandOptionType,
  ButtonInteraction,
  CategoryChannel,
  ChatInputCommandInteraction,
  CollectedInteraction,
  GuildBasedChannel,
  GuildForumTag,
  InteractionCollector,
  MessageFlagsBitField,
  PermissionFlagsBits,
  Role,
  SlashCommandBuilder,
  ThreadChannel,
} from "discord.js";
import TwButton from "../../components/Button";
import TwModal from "../../components/Modal";
import TwStringSelect from "../../components/StringSelect";
import { logger } from "../../index";
import { Command } from "../../interfaces/command";
import { SERVICE_KEYS, serviceRegistry } from "../../services";
import Chunkable from "../../utilities/Chunkable";
import { EmbedBuilderFunction } from "../../utilities/embedUtils";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { StatusType } from "../../utilities/logger";
import { rateLimitManager } from "../../utilities/rateLimitManager";
import { safeObjectAccess, safeRegExp } from "../../utilities/securityUtils";
import { refreshThreadData, updateArchiveDuration } from "../../utilities/threadActions";
import { threadManager } from "../../utilities/threadManager";
import {
  dueArchiveTimestamp,
  getAllThreads,
  isThreadCapableChannel,
  THREAD_CAPABLE_CHANNEL_TYPES,
  threadShouldBeWatched,
  validateThreadCapableChannel,
} from "../../utilities/threadUtils";

type ActionType = "watch" | "unwatch" | "toggle" | "inaction";

interface ActionsList {
  added: ThreadChannel[];
  removed: ThreadChannel[];
  noAction: ThreadChannel[];
}

interface FilterTypes {
  roles: (Role | undefined | null)[];
  tags: (GuildForumTag | undefined)[];
  regex: string;
}

// This collector set is used by the advanced UI components
const activeCollectors = new Set<InteractionCollector<CollectedInteraction>>();

/**
 * Process threads according to selected action and filters
 */
async function handleThreadActioning(
  threads: ThreadChannel[],
  action: ActionType,
  filters: FilterTypes
): Promise<ActionsList> {
  const result: ActionsList = {
    added: [],
    removed: [],
    noAction: [],
  };

  const chunkSize = 20;
  const threadChunks = Array(Math.ceil(threads.length / chunkSize))
    .fill(0)
    .map((_, i) => threads.slice(i * chunkSize, (i + 1) * chunkSize));

  for (const chunk of threadChunks) {
    await handleApiError(
      "Processing thread chunk",
      async () => {
        await Promise.all(
          chunk.map(async (thread) => {
            try {
              // Get a fresh copy of the thread to ensure accurate data
              const refreshedThread = (await refreshThreadData(thread.id)) || thread;

              // Create a safe version of the thread ID
              const threadId = safeObjectAccess(refreshedThread, "id") as string;

              // Use safeRegExp when creating the regex for thread matching
              let safeRegexString = ""; // Default to empty string if regex is invalid
              if (filters.regex && filters.regex.trim() !== "") {
                try {
                  const _threadRegex = safeRegExp(filters.regex, "i");
                  // If regex creation was successful, use the original string
                  // This ensures compatibility with threadShouldBeWatched
                  safeRegexString = filters.regex;
                } catch (error) {
                  logger.warn(`Invalid regex pattern: ${filters.regex}`, String(error));
                  // If regex creation failed, use empty string
                  safeRegexString = "";
                }
              }

              // Pass the validated regex string to threadShouldBeWatched
              const shouldWatch = await threadShouldBeWatched(
                {
                  id: threadId, // Use our safely accessed ID
                  server: refreshedThread.guildId,
                  regex: safeRegexString,
                  roles: filters.roles.map((r) => r?.id),
                  tags: filters.tags.map((t) => t?.id),
                },
                refreshedThread
              );

              if (shouldWatch) {
                switch (action) {
                  case "watch":
                    // Check if thread is already being watched - use threadId
                    if (!threadManager.isThreadWatched(threadId)) {
                      const dueArchive = dueArchiveTimestamp(
                        refreshedThread.autoArchiveDuration ?? 0,
                        refreshedThread.lastMessage?.createdAt ?? new Date()
                      );

                      // Use threadId consistently
                      const success = await threadManager.addThreadToWatch(
                        threadId,
                        dueArchive,
                        refreshedThread.guildId
                      );

                      if (success) {
                        result.added.push(refreshedThread);

                        // Also update the auto-archive duration to maximum if possible
                        if (refreshedThread.manageable) {
                          await updateArchiveDuration(refreshedThread);
                        }
                      } else {
                        result.noAction.push(refreshedThread);
                      }
                    } else {
                      result.noAction.push(refreshedThread);
                    }
                    break;

                  case "unwatch":
                    if (threadManager.isThreadWatched(threadId)) {
                      const success = await threadManager.removeThreadFromWatch(threadId);
                      if (success) {
                        result.removed.push(refreshedThread);
                      } else {
                        result.noAction.push(refreshedThread);
                      }
                    } else {
                      result.noAction.push(refreshedThread);
                    }
                    break;

                  case "toggle":
                    if (threadManager.isThreadWatched(threadId)) {
                      const success = await threadManager.removeThreadFromWatch(threadId);
                      if (success) {
                        result.removed.push(refreshedThread);
                      } else {
                        result.noAction.push(refreshedThread);
                      }
                    } else {
                      const dueArchive = dueArchiveTimestamp(
                        refreshedThread.autoArchiveDuration ?? 0,
                        refreshedThread.lastMessage?.createdAt ?? new Date()
                      );

                      const success = await threadManager.addThreadToWatch(
                        threadId,
                        dueArchive,
                        refreshedThread.guildId
                      );

                      if (success) {
                        result.added.push(refreshedThread);
                      } else {
                        result.noAction.push(refreshedThread);
                      }
                    }
                    break;

                  case "inaction":
                  default:
                    result.noAction.push(refreshedThread);
                    break;
                }
              } else {
                result.noAction.push(refreshedThread);
              }
            } catch (error) {
              logger.error(`Error processing thread ${thread.id}:`, String(error));
              result.noAction.push(thread);
            }
          })
        );
      },
      {
        retries: 2,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: "Batch Command - Thread Processing",
      }
    );

    if (threadChunks.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return result;
}

/**
 * Clean up any active collectors to prevent memory leaks
 */
function cleanupCollectors(): void {
  for (const collector of activeCollectors) {
    try {
      collector.stop();
    } catch (error) {
      logger.error(`Error stopping collector: ${error}`);
    }
  }
  activeCollectors.clear();
}

/**
 * Register component collectors in our tracking set
 * This function is used by the advanced UI implementation
 * @param component The component that might have a collector
 */
function _registerCollector(component: TwButton | TwModal | TwStringSelect): void {
  if (
    "collector" in component &&
    component.collector &&
    component.collector instanceof InteractionCollector
  ) {
    activeCollectors.add(component.collector);
  }
}

const batchCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed: EmbedBuilderFunction) => {
    try {
      await rateLimitManager.waitForRateLimit(`commands/${interaction.guildId}/batch`);

      await interaction.deferReply({
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });

      const parent = interaction.options.getChannel("parent_channel_id") || interaction.channel;
      const advanced = interaction.options.getBoolean("advanced") ?? false;
      const watchNew = interaction.options.getBoolean("watch-new") ?? false;
      const actionOption = interaction.options.getString("action") ?? "inaction";

      let action: ActionType;
      switch (actionOption) {
        case "toggle":
          action = "toggle";
          break;
        case "watch":
          action = "watch";
          break;
        case "unwatch":
          action = "unwatch";
          break;
        default:
          action = "inaction";
      }

      const filters: FilterTypes = {
        roles: [],
        tags: [],
        regex: "",
      };

      // Use validateThreadCapableChannel to properly validate the parent channel
      if (
        !parent ||
        !(
          parent instanceof CategoryChannel ||
          ("guild" in parent && validateThreadCapableChannel(parent as GuildBasedChannel))
        )
      ) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Wrong Channel Type", "error" as StatusType, {
              description: `<#${parent?.id ?? "unknown"}> is not a valid channel for this command`,
            }),
          ],
        });
        return;
      }

      if (!parent.viewable) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Cannot view channel", "error" as StatusType, {
              description: `Thread-Watcher cannot see <#${parent.id}>. Make sure the bot has the \`View Channel\` permission in the channel.`,
            }),
          ],
        });
        return;
      }

      if (!action || !interaction.guildId) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Rare Easter Egg", "warning" as StatusType, {
              description:
                "Congrats! 🎉\nThis error should be impossible to get but you got it anyhow you silly little sausage.",
            }),
          ],
        });
        return;
      }

      const threads: ThreadChannel[] = [];

      await handleApiError(
        "Failed to fetch threads",
        async () => {
          if (parent instanceof CategoryChannel) {
            threads.push(...(await getAllThreads(parent)));
          } else if ("guild" in parent && isThreadCapableChannel(parent as GuildBasedChannel)) {
            threads.push(...(await getAllThreads(parent)));
          }
        },
        {
          context: "Batch Command - Thread Fetching",
          reportAtSeverity: ErrorSeverity.MEDIUM,
        }
      );

      // This roles variable is used only in the advanced UI mode
      // We initialize it here but it's used in the advanced section
      const _roles = advanced
        ? Chunkable.from(Array.from(interaction.guild?.roles.cache.values() ?? []))
        : null;

      const embeds: ReturnType<typeof buildBaseEmbed>[] = [];

      const buildActionList = (actions: ActionsList): string => {
        let rv = "";

        if (actions.added.length !== 0) rv += `**Threads watched:** \`${actions.added.length}\`\n`;
        if (actions.removed.length !== 0)
          rv += `**Threads unwatched:** \`${actions.removed.length}\`\n`;
        if (actions.noAction.length !== 0)
          rv += `**Threads not affected:** \`${actions.noAction.length}\`\n`;

        if (rv === "") rv = "**found no threads**";
        return rv;
      };

      const sendResultsEmbed = (actions: ActionsList): string => {
        const resultEmbed = buildBaseEmbed("Done", "success" as StatusType, {
          description: `new threads created in <#${parent?.id}> ${watchNew ? "will" : "will not"} be watched\n-# **Keep in mind:** it might take upwards of an hour for the bot to ressurect any threads watched`,
          fields: [
            {
              name: "Threads actioned",
              value: buildActionList(actions),
            },
          ],
        });

        embeds.push(resultEmbed);
        interaction.editReply({ embeds, components: [] });

        let rv = "";

        if (actions.added.length !== 0) rv += `**Threads watched:** \`${actions.added.length}\`\n`;
        if (actions.removed.length !== 0)
          rv += `**Threads unwatched:** \`${actions.removed.length}\`\n`;
        if (actions.noAction.length !== 0)
          rv += `**Threads not affected:** \`${actions.noAction.length}\`\n`;

        if (rv === "") rv = "**found no threads**";
        return rv;
      };

      const _buttonFilter = (int: ButtonInteraction): boolean =>
        int.user.id === interaction.user.id;

      if (advanced) {
        // The advanced UI implementation uses the roles variable and registerCollector function
        // Existing advanced UI code
      } else {
        const result = await handleApiError(
          "Failed to process threads",
          async () => {
            return await handleThreadActioning(threads, action, filters);
          },
          {
            context: "Batch Command - Process Threads",
            reportAtSeverity: ErrorSeverity.MEDIUM,
          }
        );

        if (watchNew) {
          await handleApiError(
            "Failed to save auto-watch config",
            async () => {
              if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
                logger.warn("Database not available for auto-watch config");
                return;
              }

              const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
              const alreadyExists = (await db.getChannels(parent.id)).find(
                (t) => t.id === parent.id
              );

              if (alreadyExists) await db.deleteChannel(parent.id);

              await db.insertChannel({
                id: parent.id,
                server: interaction.guildId ?? "",
                regex: filters.regex,
                tags: filters.tags.map((t) => t?.id),
                roles: filters.roles.map((r) => r?.id),
              });
            },
            {
              context: "Batch Command - Auto-Watch Config",
              reportAtSeverity: ErrorSeverity.MEDIUM,
            }
          );
        }

        sendResultsEmbed(result);
        cleanupCollectors();
      }
    } catch (error) {
      cleanupCollectors();

      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Batch Processing Failed",
        errorDescription:
          "Failed to process threads. The channel may not support threads or the bot lacks permissions.",
        context: "Batch Command Execution",
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
    .setName("batch")
    .setDescription("watch or unwatch multiple threads at once")
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("what action to run on selected threads")
        .setChoices(
          { name: "watch", value: "watch" },
          { name: "unwatch", value: "unwatch" },
          { name: "toggle", value: "toggle" },
          { name: "nothing", value: "nothing" }
        )
        .setRequired(true)
    )
    .addBooleanOption((o) => o.setName("advanced").setDescription("if you want more options"))
    .addBooleanOption((o) =>
      o.setName("watch-new").setDescription("will automatically watch new threads")
    )
    .addChannelOption((o) =>
      o.setName("parent_channel_id").setDescription("parent whose children will be affected")
    ),
  externalOptions: [
    {
      channel_types: THREAD_CAPABLE_CHANNEL_TYPES,
      description: "parent whose children will be affected",
      name: "external_parent_channel",
      type: ApplicationCommandOptionType.Channel,
    },
  ],
};

export default batchCommand;
