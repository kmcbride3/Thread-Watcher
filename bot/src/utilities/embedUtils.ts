import {
  ActionRowBuilder,
  ColorResolvable,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
} from "discord.js";
import { config } from "../index";
import { statusType } from "../interfaces/command";

/**
 * Unified options for embed builders across the application
 */
export interface EmbedBuilderOptions {
  description?: string;
  color?: ColorResolvable;
  fields?: { name: string; value: string | number; inline?: boolean }[];
  flags?: number[];
  showAuthor?: boolean;
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  noSend?: boolean;
  ephemeral?: boolean;
  timestamp?: boolean;
  footer?: string;
}

/**
 * Standard function signature for embed builders across the application
 * Use this type for all embed builder parameters
 */
export type EmbedBuilderFunction = (
  title: string,
  status: statusType,
  options?: EmbedBuilderOptions
) => EmbedBuilder;

/**
 * Create a standardized embed based on the application style
 */
export function createEmbed(
  title: string,
  status: statusType,
  options: EmbedBuilderOptions = {}
): EmbedBuilder {
  const validStatuses = ["success", "error", "warning", "info"] as const;
  const color =
    options.color ||
    (status && validStatuses.includes(status as (typeof validStatuses)[number])
      ? (config?.style?.[status as keyof typeof config.style]?.colour as ColorResolvable)
      : "#7289DA");

  const embed = new EmbedBuilder().setTitle(title).setColor(color);

  if (options.description) {
    embed.setDescription(options.description);
  }

  if (options.fields && options.fields.length > 0) {
    embed.addFields(
      options.fields.map((field) => ({
        name: field.name,
        value: String(field.value),
        inline: field.inline,
      }))
    );
  }

  if (options.timestamp) {
    embed.setTimestamp();
  }

  if (options.footer) {
    embed.setFooter({ text: options.footer });
  }

  return embed;
}
