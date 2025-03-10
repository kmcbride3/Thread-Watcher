import { ChatInputCommandInteraction, MessageFlagsBitField, SlashCommandBuilder } from "discord.js";
import { commands } from "../../bot";
import { getShardManager } from "../../index";
import { Command, statusType } from "../../interfaces/command";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import loadCommands from "../../utilities/loadCommands";
import { rateLimitManager } from "../../utilities/rateLimitManager";
import reloadCommands from "../../utilities/routines/reloadCommands";

const reloadCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed): Promise<void> => {
    try {
      // Always immediately defer this command since it can take time
      await interaction.deferReply({
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });

      await rateLimitManager.waitForRateLimit("admin/reload");

      const globally = interaction.options.getBoolean("globally") ?? false;

      if (globally) {
        const shardManager = getShardManager();

        if (!shardManager) {
          await interaction.editReply({
            embeds: [
              buildBaseEmbed("Global Reload Failed", statusType.error, {
                description: "Shard manager is not accessible. Try reloading locally instead.",
              }),
            ],
          });
          return;
        }

        await handleApiError(
          "Failed to broadcast reload command",
          async () => {
            await reloadCommands();

            const results = await shardManager.broadcastEval(async (client) => {
              const { default: reloadCommands } = await import(
                "../../utilities/routines/reloadCommands"
              );
              await reloadCommands();
              return `Shard ${client.shard?.ids[0]} reloaded commands successfully`;
            });

            return results;
          },
          {
            context: "Global Command Reload Operation",
            reportAtSeverity: ErrorSeverity.HIGH,
          }
        );

        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Commands Reloaded Globally", statusType.success, {
              description: "All commands have been reloaded across all shards.",
            }),
          ],
        });
      } else {
        const result = await handleApiError(
          "Failed to reload commands",
          async () => {
            Object.keys(require.cache).forEach((key) => {
              if (key.includes("/commands/")) {
                Reflect.deleteProperty(require.cache, key);
              }
            });

            const loadedCommands = await loadCommands();

            const oldCommandCount = commands.size;

            commands.clear();
            for (const [key, command] of loadedCommands.entries()) {
              commands.set(key, command);
            }

            return {
              oldCount: oldCommandCount,
              newCount: commands.size,
              commandNames: [...commands.keys()],
            };
          },
          {
            context: "Local Command Reload Operation",
            retries: 0, // No retries for reload
            reportAtSeverity: ErrorSeverity.HIGH,
          }
        );

        await interaction.editReply({
          embeds: [
            buildBaseEmbed("Commands Reloaded", statusType.success, {
              description: "All commands have been reloaded on this shard.",
              fields: [
                { name: "Command Count", value: `${result.newCount} commands loaded` },
                { name: "Available Commands", value: result.commandNames.join(", ") },
              ],
            }),
          ],
        });
      }
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed, {
        errorTitle: "Reload Failed",
        errorDescription: "Failed to reload commands. Check the logs for details.",
        context: "Reload Command",
        reportAtSeverity: ErrorSeverity.HIGH,
      });
    }
  },
  gatekeeping: {
    ownerOnly: true,
    devServerOnly: false,
  },
  data: new SlashCommandBuilder()
    .setName("reload")
    .setDescription("Reload all commands")
    .addBooleanOption((o) =>
      o.setName("globally").setDescription("Reload commands on all shards").setRequired(false)
    ),
};

export default reloadCommand;
