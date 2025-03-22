import { ChatInputCommandInteraction, MessageFlagsBitField, SlashCommandBuilder } from "discord.js";
import { getCommands } from "../../bot";
import { getShardManager } from "../../index";
import { Command } from "../../interfaces/command";
import { ErrorSeverity, handleApiError, handleCommandError } from "../../utilities/errorSystem";
import loadCommands from "../../utilities/loadCommands";
import { logger, StatusType } from "../../utilities/logger";
import { rateLimitManager } from "../../utilities/rateLimitManager";
import reloadCommands from "../../utilities/routines/reloadCommands";

const commands = getCommands();

/**
 * Safely clear command module cache with proper security checks
 */
function safelyClearCommandCache(): string[] {
  const commandPattern = /[/\\]commands[/\\]/;
  const cleared: string[] = [];

  try {
    // Get all cache keys first
    const keys = Object.keys(require.cache);

    // Get project root directory dynamically instead of hardcoding
    const projectRoot = process.cwd();

    // Filter to only include command modules
    const commandModuleKeys = keys.filter((key) => {
      // Basic path validation
      if (!key.startsWith("/") || !commandPattern.test(key)) {
        return false;
      }
      // Extra validation: must be a .js or .ts file in our project directory
      return /\.(js|ts)$/.test(key) && key.includes(projectRoot);
    });

    // Clear the matching modules
    for (const key of commandModuleKeys) {
      try {
        if (Object.hasOwn(require.cache, key)) {
          const deleted = Reflect.deleteProperty(require.cache, key);
          if (deleted) {
            cleared.push(key);
          }
        }
      } catch (err) {
        logger.warn(`Failed to clear module ${key} from cache: ${err}`);
      }
    }

    logger.debug(`Cleared ${cleared.length} command modules from cache`);
    return cleared;
  } catch (error) {
    logger.error(`Error clearing command module cache: ${error}`);
    return [];
  }
}

const reloadCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
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
              buildBaseEmbed("Global Reload Failed", "error" as StatusType, {
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
            buildBaseEmbed("Commands Reloaded Globally", "success" as StatusType, {
              description: "All commands have been reloaded across all shards.",
            }),
          ],
        });
      } else {
        const result = await handleApiError(
          "Failed to reload commands",
          async () => {
            safelyClearCommandCache();

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
            buildBaseEmbed("Commands Reloaded", "success" as StatusType, {
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
