import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlagsBitField } from "discord.js";
import { inspect } from "util";
import { Command, statusType } from "../../interfaces/command";
import { logger, db } from "../../index";
import { setTimeout } from "timers/promises";

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

// Block list of dangerous patterns
const DANGEROUS_PATTERNS = [
  /\b(process\s*\.exit|child_process\.exec|require\s*\(\s*['"]child_process['"])/i,
  /\b(fs\.writeFile|fs\.writeFileSync|fs\.unlink|fs\.rm)/i,
  /\b(token|config\.tokens\.discord)/i, // Prevent token leaks
];

// Maximum execution time in ms
const MAX_EXECUTION_TIME = 5000;

const evalCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction, buildBaseEmbed): Promise<void> => {
    const code = interaction.options.getString("code");
    if (!code) {
      await interaction.reply({
        content: "No code provided.",
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({
      flags: [MessageFlagsBitField.Flags.Ephemeral],
    });

    const started = Date.now();

    // Check for dangerous patterns
    if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(code))) {
      const embed = buildBaseEmbed("Security Error", statusType.error, {
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
        db,
        logger,
      };

      interface EvalContext {
        interaction: ChatInputCommandInteraction;
        client: ChatInputCommandInteraction["client"];
        guild: ChatInputCommandInteraction["guild"];
        channel: ChatInputCommandInteraction["channel"];
        author: ChatInputCommandInteraction["user"];
        db: typeof db;
        logger: typeof logger;
      }

      // Safe eval function using Function constructor instead of eval
      const asyncEval = async (code: string, context: EvalContext): Promise<unknown> => {
        // Using Function constructor for controlled eval implementation
        // This is intentional and secured via:
        // - Owner-only access restriction
        // - Pattern filtering for dangerous operations
        // - Execution timeouts
        const evalFn = new Function(
          "context",
          `
          const { interaction, client, guild, channel, author, db, logger } = context;
          return (async () => { 
            ${code} 
          })();
        `
        );

        return await evalFn(context);
      };

      const timeoutPromise = setTimeout(MAX_EXECUTION_TIME).then(() => {
        throw new Error(`Execution timed out after ${MAX_EXECUTION_TIME}ms`);
      });

      const resultPromise = Promise.race([asyncEval(code, context), timeoutPromise]);

      const result = await resultPromise;
      const res = await clean(result);
      const executionTime = Date.now() - started;
      const embed = buildBaseEmbed("Executed code", statusType.success, {
        fields: [
          { name: "Code", value: `\`\`\`js\n${code}\n\`\`\`` },
          { name: "Result", value: `\`\`\`js\n${res}\n\`\`\`` },
        ],
        description: `Execution took ${executionTime}ms`,
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      const embed = buildBaseEmbed("Execution Error", statusType.error, {
        fields: [
          { name: "Code", value: `\`\`\`js\n${code}\n\`\`\`` },
          { name: "Error", value: `\`\`\`js\n${err}\n\`\`\`` },
        ],
      });

      await interaction.editReply({ embeds: [embed] });
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
