import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CategoryChannel,
  ChatInputCommandInteraction,
  CollectedInteraction,
  EmbedBuilder,
  ForumChannel,
  GuildBasedChannel,
  GuildForumTag,
  InteractionCollector,
  MessageFlagsBitField,
  PermissionFlagsBits,
  Role,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ThreadChannel,
} from "discord.js";
import { threads as threadsList } from "../../bot";
import TwButton from "../../components/Button";
import TwModal from "../../components/Modal";
import TwStringSelect from "../../components/StringSelect";
import { db, logger } from "../../index";
import { Command, statusType } from "../../interfaces/command";
import Chunkable from "../../utilities/Chunkable";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import { rateLimitManager } from "../../utilities/rateLimitManager";
import { strToRegex, validRegex } from "../../utilities/regex";
import { addThread, dueArchiveTimestamp, removeThread } from "../../utilities/threadActions";
import {
  getAllThreads,
  isThreadCapableChannel,
  THREAD_CAPABLE_CHANNEL_TYPES,
  threadShouldBeWatched,
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
              const shouldWatch = await threadShouldBeWatched(
                {
                  id: thread.id,
                  server: thread.guildId,
                  regex: filters.regex ?? "",
                  roles: filters.roles.map((r) => r?.id),
                  tags: filters.tags.map((t) => t?.id),
                },
                thread
              );

              if (shouldWatch) {
                switch (action) {
                  case "watch":
                    if (!threadsList.get(thread.id)?.watching) {
                      await addThread(
                        thread.id,
                        dueArchiveTimestamp(
                          thread.autoArchiveDuration ?? 0,
                          thread.lastMessage?.createdAt ?? new Date()
                        ),
                        thread.guildId
                      );
                      result.added.push(thread);
                    } else {
                      result.noAction.push(thread);
                    }
                    break;

                  case "unwatch":
                    if (threadsList.has(thread.id)) {
                      await removeThread(thread.id);
                      result.removed.push(thread);
                    } else {
                      result.noAction.push(thread);
                    }
                    break;

                  case "toggle":
                    if (threadsList.get(thread.id)?.watching) {
                      await removeThread(thread.id);
                      result.removed.push(thread);
                    } else {
                      await addThread(
                        thread.id,
                        dueArchiveTimestamp(
                          thread.autoArchiveDuration ?? 0,
                          thread.lastMessage?.createdAt ?? new Date()
                        ),
                        thread.guildId
                      );

                      result.noAction.push(thread);
                    }
                    break;

                  case "inaction":
                  default:
                    result.noAction.push(thread);
                    break;
                }
              } else {
                result.noAction.push(thread);
              }
            } catch (error) {
              console.error(`Error processing thread ${thread.id}:`, error);
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
 * @param component The component that might have a collector
 */
function registerCollector(component: TwButton | TwModal | TwStringSelect): void {
  if (
    "collector" in component &&
    component.collector &&
    component.collector instanceof InteractionCollector
  ) {
    activeCollectors.add(component.collector);
  }
}

const batchCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed): Promise<void> => {
    try {
      await rateLimitManager.waitForRateLimit(`commands/${interaction.guildId}/batch`);

      await interaction.deferReply();

      const parent = interaction.options.getChannel("parent") || interaction.channel;
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

      if (
        !parent ||
        !(
          parent instanceof CategoryChannel ||
          ("guild" in parent && isThreadCapableChannel(parent as GuildBasedChannel))
        )
      ) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Wrong Channel Type", statusType.error, {
              description: `<#${parent?.id ?? "unknown"}> is not a valid channel for this command`,
            }),
          ],
        });
        return;
      }

      if (!parent.viewable) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Cannot view channel", statusType.error, {
              description: `Thread-Watcher cannot see <#${parent.id}>. Make sure the bot has the \`View Channel\` permission in the channel.`,
            }),
          ],
        });
        return;
      }

      if (!action || !interaction.guildId) {
        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Rare Easter Egg", statusType.warning, {
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

      const roles = Chunkable.from(Array.from(interaction.guild?.roles.cache.values() ?? []));

      const embeds: EmbedBuilder[] = [];

      const buildActionList = (actions: ActionsList) => {
        let rv = "";

        if (actions.added.length !== 0) rv += `**Threads watched:** \`${actions.added.length}\`\n`;
        if (actions.removed.length !== 0)
          rv += `**Threads unwatched:** \`${actions.removed.length}\`\n`;
        if (actions.noAction.length !== 0)
          rv += `**Threads not affected:** \`${actions.noAction.length}\`\n`;

        if (rv === "") rv = "**found no threads**";
        return rv;
      };

      const sendResultsEmbed = (actions: ActionsList) => {
        const resultEmbed = buildBaseEmbed("Done", statusType.success, {
          noSend: true,
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

      const buttonFilter = (int: ButtonInteraction) => int.user.id === interaction.user.id;

      if (advanced) {
        const filterEmbed = buildBaseEmbed("Filter Options", statusType.info, {
          noSend: true,
          description: `
            The bot will only handle threads that match the criteria set by you below.

            → If multiple roles are selected, the thread owner **needs only one** for the thread to be watched
            → The same is true for post tags
          `,
        });

        const regexRowComponents = new ActionRowBuilder<ButtonBuilder>();
        const rolesSelectComponents = new ActionRowBuilder<StringSelectMenuBuilder>();
        const rolesRowNavigationComponents = new ActionRowBuilder<ButtonBuilder>();
        const tagsSelectComponents = new ActionRowBuilder<StringSelectMenuBuilder>();
        const confirmationButtonComponents = new ActionRowBuilder<ButtonBuilder>();

        embeds.push(filterEmbed);
        const components = [
          regexRowComponents,
          rolesSelectComponents,
          rolesRowNavigationComponents,
        ];

        if (parent instanceof ForumChannel && parent.availableTags.length !== 0) {
          components.push(tagsSelectComponents);
        }

        components.push(confirmationButtonComponents);

        const genEmbedFields = () => {
          filterEmbed.setFields([
            {
              name: "Roles",
              value: filters.roles.map((r) => `<@&${r?.id}>`).join(", ") || "none selected",
              inline: true,
            },
            {
              name: "Tags",
              value: filters.tags.map((t) => `${t?.name}`).join(", ") || "none selected",
              inline: true,
            },
            {
              name: "Pattern",
              value: `\`${filters.regex || "none"}\``,
              inline: true,
            },
          ]);
        };

        const updateEmbed = (i: ButtonInteraction | CollectedInteraction) => {
          genEmbedFields();
          interaction.editReply({ embeds: [filterEmbed], components });

          if (!i.replied && "update" in i) {
            i.update({ content: "Choice saved" });
          }
        };

        const tagsSelect = () => {
          if (!(parent instanceof ForumChannel)) return;

          const select = new TwStringSelect();
          registerCollector(select);

          select.select
            .setPlaceholder("select tags!")
            .setMinValues(1)
            .setMaxValues(parent.availableTags.length);

          for (const i of parent.availableTags) {
            const option = new StringSelectMenuOptionBuilder()
              .setLabel(i.name)
              .setDescription(`${i.id}`)
              .setValue(i.id);
            select.select.addOptions(option);
          }

          select.filter = (i) => i.user.id === interaction.user.id;
          select.onSubmit((i) => {
            filters.tags = i.values.map((tagId) =>
              parent.availableTags.find((tag) => tag.id === tagId)
            );
            updateEmbed(i);
          });

          tagsSelectComponents.addComponents(select.select);
        };

        const roleNavigation = () => {
          let rolesPage = roles.current;
          const select = new TwStringSelect();
          registerCollector(select);

          const setSelectValues = () => {
            if (rolesPage.length === 0) return;
            select.select
              .setPlaceholder("select roles!")
              .setMinValues(1)
              .setMaxValues(rolesPage.length)
              .setOptions([]);

            for (const i of rolesPage) {
              const option = new StringSelectMenuOptionBuilder()
                .setLabel(i.name)
                .setDescription(
                  Math.random() > 0.995
                    ? "wow an easter egg???"
                    : `${i.members.size} members has this role`
                )
                .setValue(i.id);

              select.select.addOptions(option);
            }
          };

          setSelectValues();

          const nextButton = new TwButton("next", ButtonStyle.Secondary, { emoji: "▶" });
          const prevButton = new TwButton("prev", ButtonStyle.Secondary, { emoji: "◀" });
          const clearButton = new TwButton("clear", ButtonStyle.Danger, { emoji: "🗑️" });

          registerCollector(nextButton);
          registerCollector(prevButton);
          registerCollector(clearButton);

          nextButton.filter = buttonFilter;
          prevButton.filter = buttonFilter;
          clearButton.filter = buttonFilter;
          select.filter = (i) => i.user.id === interaction.user.id;
          clearButton.button.setDisabled(true);

          clearButton.onclick(async (i) => {
            await handleApiError(
              "Failed to clear roles",
              () => {
                filters.roles = [];
                clearButton.button.setDisabled(true);
                updateEmbed(i);

                return Promise.resolve();
              },
              {
                context: "Batch Command - Clear Roles",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          nextButton.onclick(async (i) => {
            await handleApiError(
              "Failed to navigate roles",
              () => {
                rolesPage = roles.forwards();
                setSelectValues();
                updateEmbed(i);

                return Promise.resolve();
              },
              {
                context: "Batch Command - Next Roles Page",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          prevButton.onclick(async (i) => {
            await handleApiError(
              "Failed to navigate roles",
              () => {
                rolesPage = roles.back();
                setSelectValues();
                updateEmbed(i);

                return Promise.resolve();
              },
              {
                context: "Batch Command - Previous Roles Page",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          select.onSubmit(async (i) => {
            await handleApiError(
              "Failed to select roles",
              () => {
                filters.roles.push(...i.values.map((rId) => i.guild?.roles.cache.get(rId)));
                clearButton.button.setDisabled(false);
                updateEmbed(i);

                return Promise.resolve();
              },
              {
                context: "Batch Command - Role Selection",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          rolesRowNavigationComponents.addComponents(
            prevButton.button,
            clearButton.button,
            nextButton.button
          );
          rolesSelectComponents.addComponents(select.select);
        };

        const regexButtons = () => {
          const setButton = new TwButton("Select Pattern", ButtonStyle.Primary);
          const tryButton = new TwButton("Try Pattern", ButtonStyle.Secondary);
          const clearButton = new TwButton("Clear Pattern", ButtonStyle.Danger);

          registerCollector(setButton);
          registerCollector(tryButton);
          registerCollector(clearButton);

          setButton.filter = buttonFilter;
          tryButton.filter = buttonFilter;
          clearButton.filter = buttonFilter;
          tryButton.button.setDisabled(true);
          clearButton.button.setDisabled(true);

          setButton.onclick(async (i) => {
            await handleApiError(
              "Failed to show regex modal",
              async () => {
                const modal = new TwModal("Enter Pattern");
                registerCollector(modal);

                modal.addInput("pattern", "pattern");
                modal.filter = (i) => i.user.id === interaction.user.id;

                modal.onSubmit(async (response) => {
                  const ptrn = response.fields.getTextInputValue("pattern");
                  const isRegexValid = validRegex(ptrn);

                  if (isRegexValid.valid) {
                    filters.regex = ptrn;
                    await response.reply({
                      flags: [MessageFlagsBitField.Flags.Ephemeral],
                      content: "saved",
                    });
                  } else {
                    const embed = buildBaseEmbed("Syntax Error", statusType.error, {
                      noSend: true,
                      description: `the pattern you provided (\`${ptrn}\`) is not valid due to ${isRegexValid.reason}. Read the documentation on [**patterns**](https://example.com) for more info!`,
                    });
                    await response.reply({
                      flags: [MessageFlagsBitField.Flags.Ephemeral],
                      embeds: [embed],
                    });
                  }

                  clearButton.button.setDisabled(false);
                  tryButton.button.setDisabled(false);
                  updateEmbed(i);
                });

                await i.showModal(modal.modal);
              },
              {
                context: "Batch Command - Pattern Modal",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          clearButton.onclick(async (i) => {
            await handleApiError(
              "Failed to clear pattern",
              () => {
                filters.regex = "";
                clearButton.button.setDisabled(true);
                tryButton.button.setDisabled(false);
                updateEmbed(i);

                return Promise.resolve();
              },
              {
                context: "Batch Command - Clear Pattern",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          tryButton.onclick(async (i) => {
            await handleApiError(
              "Failed to test pattern",
              async () => {
                const testThreads = threads.slice(0, 10);
                const regex = strToRegex(filters.regex);
                const embed = buildBaseEmbed("Test Results", statusType.info, {
                  noSend: true,
                  description: `pattern: \`${filters.regex}\` ${regex.inverted ? "**(INVERTED)**" : ""}`,
                });

                embed.addFields({
                  name: "Results",
                  value:
                    testThreads
                      .map((e) => `**${e.name}**: ${regex.regex.test(e.name) !== regex.inverted}`)
                      .join("\n") || "No threads to test",
                });

                await i.reply({ embeds: [embed], flags: [MessageFlagsBitField.Flags.Ephemeral] });
              },
              {
                context: "Batch Command - Test Pattern",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          regexRowComponents.addComponents(setButton.button, clearButton.button, tryButton.button);
        };

        const confirmButtons = () => {
          const confirm = new TwButton("Confirm Choices", ButtonStyle.Success);
          const cancel = new TwButton("Cancel", ButtonStyle.Danger);

          registerCollector(confirm);
          registerCollector(cancel);

          confirm.filter = buttonFilter;
          cancel.filter = buttonFilter;

          cancel.onclick(async (i) => {
            await handleApiError(
              "Failed to cancel",
              async () => {
                cleanupCollectors();

                const embedMessage = buildBaseEmbed("Cancelled!", statusType.warning, {
                  noSend: true,
                });
                await i.update({ embeds: [embedMessage], components: [] });
              },
              {
                context: "Batch Command - Cancel",
                reportAtSeverity: ErrorSeverity.LOW,
              }
            );
          });

          confirm.onclick(async (i) => {
            await handleApiError(
              "Failed to process threads",
              async () => {
                cleanupCollectors();

                filterEmbed.setColor("Green");
                await i.update({ embeds: [filterEmbed], components: [] });

                const result = await handleThreadActioning(threads, action, filters);

                if (watchNew) {
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
                }

                sendResultsEmbed(result);
              },
              {
                context: "Batch Command - Confirm",
                reportAtSeverity: ErrorSeverity.MEDIUM,
              }
            );
          });

          confirmationButtonComponents.addComponents(confirm.button, cancel.button);
        };

        regexButtons();
        roleNavigation();
        tagsSelect();
        confirmButtons();
        genEmbedFields();

        await interaction.editReply({
          embeds: [filterEmbed],
          components,
        });
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
          ...[
            { name: "watch", value: "watch" },
            { name: "unwatch", value: "unwatch" },
            { name: "toggle", value: "toggle" },
            { name: "nothing", value: "nothing" },
          ]
        )
        .setRequired(true)
    )
    .addBooleanOption((o) => o.setName("advanced").setDescription("if you want more options"))
    .addBooleanOption((o) =>
      o.setName("watch-new").setDescription("will automatically watch new threads")
    ),
  externalOptions: [
    {
      channel_types: THREAD_CAPABLE_CHANNEL_TYPES,
      description: "parent whose children will be affected",
      name: "parent",
      type: ApplicationCommandOptionType.Channel,
    },
  ],
};

export default batchCommand;
