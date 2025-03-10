import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CategoryChannel,
  ChatInputCommandInteraction,
  ColorResolvable,
  EmbedBuilder,
  GuildMember,
  Interaction,
  MessageFlagsBitField,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import TwButton from "../../components/Button";
import { config, db } from "../../index";
import { Command } from "../../interfaces/command";
import Chunkable from "../../utilities/Chunkable";
import { handleApiError, handleCommandError } from "../../utilities/errorSystem";
import {
  getDirectTag,
  isThreadCapableChannel,
  isThreadChannel,
  THREAD_CHANNEL_TYPES,
  ThreadCapableChannel,
} from "../../utilities/threadUtils";

interface field {
  name: string;
  value: string;
}

interface I_Entry {
  text: string;
  id: string;
}

interface I_DataResponse {
  okValues: I_Entry[];
  failValues: I_Entry[];
}

/**
 * This function will split an array of discord channel tags ( <#CHANNEL_ID> ) into embed fields of 1024 chars each
 * as some of yall have a metric tonne of watched threads.
 * The function also limits the total chars of embed field values to a total of 5500 to not bypass the hardlimit of
 * 6000 chars per embed object.
 *
 * This might make it now show all threads if any user out there somehow manages to have 5500 chars worth of threads stored
 * which is why this function will be supplemented with a function to create more embeds if needed as 10 embeds are allowed per interaction response
 */
const fitIntoFields = (
  name: string,
  values: string[],
  totalLength = 0
): { fieldArr: field[]; totalLength: number } => {
  // Embed limits https://discord.com/developers/docs/resources/message#embed-object-embed-limits
  const MAXLENGTH = 1024;

  const fields: field[] = [];
  let buff = "";
  let currentLength = totalLength;

  for (const value of values) {
    // Length of the buffer plus the string currently added to it
    const iLength = buff.length + value.length + 2;
    currentLength += value.length + 2;

    /**
     * ensure the current thread can fit into the current field (buff).
     * If not: push the current field into the array and initiate a new one with the current value
     */
    if (iLength > MAXLENGTH) {
      fields.push({
        name: `${name} ${fields.length + 1}`,
        value: buff.substring(0, buff.length - 2),
      });
      buff = `${value}, `;
    } else {
      buff += `${value}, `;
    }
  }

  fields.push({
    name: `${name} ${fields.length + 1}`,
    value: buff.substring(0, buff.length - 2),
  });

  return { fieldArr: fields, totalLength: currentLength };
};

/**
 * Get channels for the current guild with proper permissions checking
 */
const getChannels = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.guildId) return { okValues: [], failValues: [] };

  return await handleApiError(
    "Failed to get channel data",
    async () => {
      const returnValues: I_DataResponse = { okValues: [], failValues: [] };
      const channels = await db.getChannels(interaction.guildId as string);

      for (const channelData of channels) {
        try {
          const channel = await interaction.client.channels.fetch(channelData.id).catch(() => null);
          if (channel && "guild" in channel) {
            if (
              !(
                (isThreadCapableChannel(channel as ThreadCapableChannel) ||
                  channel instanceof CategoryChannel) &&
                interaction.member instanceof GuildMember
              )
            )
              break;

            if (channel.permissionsFor(interaction.member).has(PermissionFlagsBits.ViewChannel)) {
              if (
                isThreadCapableChannel(channel as ThreadCapableChannel) ||
                channel instanceof CategoryChannel
              ) {
                returnValues.okValues.push({
                  text: getDirectTag(channel as ThreadCapableChannel | CategoryChannel),
                  id: channel.id,
                });
              } else {
                returnValues.okValues.push({
                  text: `[#${channel.name}](https://discord.com/channels/${channel.guildId}/${channel.id})`,
                  id: channel.id,
                });
              }
            }
          } else {
            returnValues.failValues.push({
              text: `${channelData.id} (*unknown channel*)`,
              id: channelData.id,
            });
          }
        } catch {
          returnValues.failValues.push({
            text: `${channelData.id} (*error fetching channel*)`,
            id: channelData.id,
          });
        }
      }
      return returnValues;
    },
    { context: "List Command - Channel Data Fetching" }
  );
};

/**
 * Get threads for the current guild with proper permissions checking
 */
const getThreads = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.guildId) return { okValues: [], failValues: [] };

  return await handleApiError(
    "Failed to get thread data",
    async () => {
      const returnValues: I_DataResponse = { okValues: [], failValues: [] };

      const threads = await db.getThreads(interaction.guildId as string);

      for (const _t of threads) {
        try {
          const thread = await interaction.client.channels.fetch(_t.id).catch(() => null);
          if (thread) {
            if (
              !THREAD_CHANNEL_TYPES.includes(thread.type as (typeof THREAD_CHANNEL_TYPES)[number])
            )
              continue;
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ViewChannel)) continue;
            if (!_t.watching) continue;

            if ("guild" in thread) {
              if (isThreadChannel(thread)) {
                returnValues.okValues.push({
                  text: getDirectTag(thread),
                  id: thread.id,
                });
              }
            }
          } else {
            returnValues.failValues.push({
              text: `${_t.id} (*unknown thread*)`,
              id: _t.id,
            });
          }
        } catch {
          returnValues.failValues.push({
            text: `${_t.id} (*error fetching thread*)`,
            id: _t.id,
          });
        }
      }

      return returnValues;
    },
    { context: "List Command - Thread Data Fetching" }
  );
};

const listCommand: Command = {
  run: async (interaction: ChatInputCommandInteraction) => {
    let chunks: Chunkable<field>;
    let display: (btnInteraction?: ButtonInteraction) => void;
    let showVar = "";
    try {
      let pub = interaction.options.getBoolean("public");
      const show = interaction.options.getString("show") || "thread";
      showVar = show;

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads) && pub)
        pub = false;

      await interaction.deferReply({
        flags: pub ? [] : [MessageFlagsBitField.Flags.Ephemeral],
      });

      const res =
        show === "channel"
          ? await getChannels(interaction)
          : ((await getThreads(interaction)) as I_DataResponse);

      const fields = fitIntoFields(show, [
        ...res.okValues.map((v) => v.text),
        ...res.failValues.map((v) => v.text),
      ]).fieldArr;

      if (fields.length === 0 || (fields.length === 1 && fields[0].value === "")) {
        const nothingEmbed = new EmbedBuilder()
          .setColor(config.style.info.colour as ColorResolvable)
          .setTitle(`No ${show}s found`)
          .setDescription(`No ${show}s are being watched in this server.`);

        await interaction.editReply({ embeds: [nothingEmbed] });
        return;
      }

      chunks = Chunkable.from(fields, 5);
      display = (btnInteraction?: ButtonInteraction) => {
        const embed = new EmbedBuilder().setColor(config.style.success.colour as ColorResolvable);
        const navComponents = new ActionRowBuilder<ButtonBuilder>();
        const filter = (i: Interaction) => i.user.id === interaction.user.id;
        const back = new TwButton("<", ButtonStyle.Primary, {
          disabled: chunks.currentPointer === 0,
        });
        back.filter = filter;
        const forwards = new TwButton(">", ButtonStyle.Primary, {
          disabled: chunks.currentPointer === chunks.pages - 1,
        });
        forwards.filter = filter;
        navComponents.addComponents(back.button, forwards.button);
        embed.setFields(chunks.current);
        embed.setFooter({
          text: `Page ${chunks.currentPointer + 1}/${chunks.pages}`,
        });
        embed.setTitle(`${showVar === "channel" ? "Channels" : "Threads"} being watched`);
        forwards.onclick((i) => {
          chunks.next();
          display(i);
        });
        back.onclick((i) => {
          chunks.back();
          display(i);
        });
        const options = {
          embeds: [embed],
          components: chunks.pages > 1 ? [navComponents] : [],
        };
        if (btnInteraction) {
          btnInteraction.update(options);
        } else {
          interaction.editReply(options);
        }
      };

      display();
    } catch (error) {
      await handleCommandError(
        interaction,
        error,
        (title, status, options) => {
          const embed = new EmbedBuilder()
            .setColor(config.style.error.colour as ColorResolvable)
            .setTitle(title);

          if (options?.description) {
            embed.setDescription(options.description);
          }

          if (options?.fields) {
            embed.setFields(
              options.fields.map((field) => ({ ...field, value: String(field.value) }))
            );
          }

          return embed;
        },
        {
          errorTitle: "List Command Failed",
          errorDescription: "Failed to list watched threads or channels. Please try again later.",
          context: "List Command",
        }
      );
    }
  },
  data: new SlashCommandBuilder()
    .setName("list")
    .setDescription("List your watched threads and channels")
    .addBooleanOption((o) =>
      o.setName("public").setDescription("Do you want this message to be viewable for everyone?")
    )
    .addStringOption((o) =>
      o
        .setName("show")
        .setDescription("Do you want to view watched threads or channels?")
        .addChoices({ name: "threads", value: "thread" }, { name: "channels", value: "channel" })
    ),
};

export default listCommand;
