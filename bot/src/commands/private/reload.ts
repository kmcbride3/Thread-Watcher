import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlagsBitField } from "discord.js";
import { Command, statusType } from "../../interfaces/command";
import reloadCommands from "../../utilities/routines/reloadCommands";
import { isMainProcess } from "../../utilities/processState";
import { getConfig } from "../../utilities/cnf/index";

const config = getConfig();

const reload: Command = {
    run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
        const all = interaction.options.getBoolean("globally");

        // Check if the user is an owner
        const isOwner = config.owners.includes(interaction.user.id);

        // Check if the command is being run on the dev server
        const isDevServer = config.devServer === interaction.guildId;

        let embed;

        if (all) {
            if (reload.gatekeeping?.ownerOnly && !isOwner) {
                embed = buildBaseEmbed("Permission denied", statusType.error, {
                    description: "You do not have permission to run this command globally.",
                });
            } else if (reload.gatekeeping?.devServerOnly && !isDevServer) {
                embed = buildBaseEmbed("Invalid server", statusType.error, {
                    description: "This command can only be run on the development server.",
                });
            } else if (!isMainProcess()) {
                // Send a message to the main process to execute the command
                if (process.send) {
                    process.send({ op: 'RELOAD_COMMANDS', globally: true });
                } else {
                    embed = buildBaseEmbed("Unable to forward command to main", statusType.error, {
                        description: "Forwarding command to the main process for execution has failed.",
                    });
                }
                embed = buildBaseEmbed("Command forwarded to main process", statusType.info, {
                    description: "The command has been forwarded to the main process for execution.",
                });
            } else if (!interaction.client.shard) {
                // If sharding is not enabled, call reloadCommands normally
                await reloadCommands();
                embed = buildBaseEmbed("Commands reloaded", statusType.success);
            } else {
                embed = buildBaseEmbed("Reloading commands on all shards...", statusType.info);
                await interaction.reply({ embeds: [embed], flags: [MessageFlagsBitField.Flags.Ephemeral] });

                try {
                    const results = await interaction.client.shard.broadcastEval(async (client) => {
                        const { default: reloadCommands } = await import("../../utilities/routines/reloadCommands");
                        await reloadCommands();
                        return `Shard ${client.shard?.ids[0]} reloaded commands.`;
                    });

                    embed = buildBaseEmbed("Commands reloaded on all shards", statusType.success, {
                        description: results.join("\n"),
                    });
                    await interaction.editReply({ embeds: [embed] });
                    return;
                } catch (error) {
                    embed = buildBaseEmbed("Failed to reload commands on all shards", statusType.error, {
                        description: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    });
                    await interaction.editReply({ embeds: [embed] });
                    return;
                }
            }
        } else {
            await reloadCommands();
            embed = buildBaseEmbed("Commands reloaded", statusType.success);
        }

        await interaction.reply({ embeds: [embed], flags: [MessageFlagsBitField.Flags.Ephemeral] });
    },
    gatekeeping: {
        ownerOnly: true,
        devServerOnly: true
    },
    data: new SlashCommandBuilder()
        .setName("reload")
        .setDescription("use this command to reload commands")
        .addBooleanOption((o) => 
            o
            .setName("globally")
            .setDescription("do you want to reload commands on all shards?")
        )
}

export default reload