import { ChatInputCommandInteraction, MessageFlagsBitField, SlashCommandBuilder } from "discord.js";
import { setTimeout } from "timers/promises";
import { inspect } from "util";
import { Command } from "../../interfaces/command";
import { handleCommandError } from "../../utilities/errorSystem";
import { StatusType } from "../../utilities/logger";
import { safeObjectAccess, safeRegExp } from "../../utilities/securityUtils";

// This function cleans up and prepares the
// result of our eval command input for sending
// to the channel
const clean = async (text: string | unknown) => {
  // Create a new variable instead of modifying the parameter
  let result = text;
  if (result && result.constructor.name === "Promise") result = await Promise.resolve(result);
  const inspected = inspect(result, { depth: 1 });
  return inspected.replace(/[`@]/g, (m) => `${m}\u200b`);
};

// Block list of dangerous patterns - now using safeRegExp for safer pattern creation
const DANGEROUS_PATTERNS = [
  safeRegExp(
    "\\b(process\\s*\\.exit|child_process\\.exec|require\\s*\\(\\s*['\"]child_process['\"])"
  ),
  safeRegExp("\\b(fs\\.writeFile|fs\\.writeFileSync|fs\\.unlink|fs\\.rm)"),
  safeRegExp("\\b(token|config\\.tokens\\.discord)"), // Prevent token leaks
];

// Maximum execution time in ms
const MAX_EXECUTION_TIME = 5000;

// List of allowed properties to access from context objects
const ALLOWED_CONTEXT_PROPERTIES = [
  "id",
  "name",
  "displayName",
  "username",
  "tag",
  "isPartial",
  "type",
  "content",
  "createdAt",
  "channelId",
  "guildId",
  "authorId",
];

const evalCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed) => {
    try {
      await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] });

      const code = interaction.options.getString("code", true);
      const started = Date.now();

      // Check for dangerous patterns
      if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(code))) {
        const embed = buildBaseEmbed("Security Error", "error" as StatusType, {
          fields: [
            { name: "Code", value: `\`\`\`js\n${code}\n\`\`\`` },
            {
              name: "Error",
              value: "This code contains potentially dangerous operations that are blocked.",
            },
          ],
        });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      try {
        const context = {
          interaction,
          client: interaction.client,
          guild: interaction.guild,
          channel: interaction.channel,
          author: interaction.user,
        };

        // Enhanced eval function with safer object access
        const asyncEval = async (
          code: string,
          context: {
            interaction: ChatInputCommandInteraction;
            client: ChatInputCommandInteraction["client"];
            guild: ChatInputCommandInteraction["guild"];
            channel: ChatInputCommandInteraction["channel"];
            author: ChatInputCommandInteraction["user"];
          }
        ): Promise<unknown> => {
          // Wrap the context with safer access
          const safeContext = {
            interaction: (prop: string) =>
              safeObjectAccess(context.interaction, prop, ALLOWED_CONTEXT_PROPERTIES),
            client: (prop: string) =>
              safeObjectAccess(context.client, prop, ALLOWED_CONTEXT_PROPERTIES),
            guild: (prop: string) =>
              context.guild
                ? safeObjectAccess(context.guild, prop, ALLOWED_CONTEXT_PROPERTIES)
                : undefined,
            channel: (prop: string) =>
              context.channel
                ? safeObjectAccess(context.channel, prop, ALLOWED_CONTEXT_PROPERTIES)
                : undefined,
            author: (prop: string) =>
              safeObjectAccess(context.author, prop, ALLOWED_CONTEXT_PROPERTIES),
          };

          // Using Function constructor for controlled eval implementation
          const evalFn = new Function(
            "safeContext",
            "safeObjectAccess",
            `
            // Provide safe accessors for interactions with context objects
            const interaction = (prop) => safeContext.interaction(prop);
            const client = (prop) => safeContext.client(prop);
            const guild = (prop) => safeContext.guild(prop);
            const channel = (prop) => safeContext.channel(prop);
            const author = (prop) => safeContext.author(prop);
            
            return (async () => { 
              ${code} 
            })();
            `
          );

          return await evalFn(safeContext, safeObjectAccess);
        };

        const timeoutPromise = setTimeout(MAX_EXECUTION_TIME).then(() => {
          throw new Error(`Execution timed out after ${MAX_EXECUTION_TIME}ms`);
        });

        const resultPromise = Promise.race([asyncEval(code, context), timeoutPromise]);
        const result = await resultPromise;
        const executionTime = Date.now() - started;

        // Format the result
        const formattedResult = await clean(result);

        // Send the result
        const embed = buildBaseEmbed("Eval Result", "success" as StatusType, {
          fields: [
            { name: "Code", value: `\`\`\`js\n${code}\n\`\`\`` },
            { name: "Result", value: `\`\`\`js\n${formattedResult}\n\`\`\`` },
          ],
          description: `Execution took ${executionTime}ms`,
        });

        await interaction.editReply({
          embeds: [embed],
        });
      } catch (evalError) {
        const embed = buildBaseEmbed("Eval Error", "error" as StatusType, {
          fields: [
            { name: "Code", value: `\`\`\`js\n${code}\n\`\`\`` },
            { name: "Error", value: `\`\`\`js\n${evalError}\n\`\`\`` },
          ],
        });

        await interaction.editReply({
          embeds: [embed],
        });
      }
    } catch (error) {
      await handleCommandError(interaction, error, buildBaseEmbed);
    }
  },
  gatekeeping: {
    ownerOnly: true,
    devServerOnly: true,
  },
  data: new SlashCommandBuilder()
    .setName("eval")
    .setDescription("Execute code with safety checks")
    .addStringOption((o) =>
      o.setName("code").setDescription("The code to execute (with safety checks)").setRequired(true)
    ),
};

export default evalCommand;
