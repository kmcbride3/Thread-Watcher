import {
  ActionRowBuilder,
  APIButtonComponentWithCustomId,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ColorResolvable,
  CommandInteraction,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  MessageComponentInteraction,
  MessageFlagsBitField,
} from "discord.js";
import { config } from "../index";
import { StatusType } from "./logger";

// Fix import path for Chunkable
import Chunkable from "./Chunkable";
import { isInteractionReplyable, safeSendInteractionReply } from "./interactionUtils";

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
  status: StatusType,
  options?: EmbedBuilderOptions
) => EmbedBuilder;

/**
 * Create a standardized embed based on the application style
 */
export function createEmbed(
  title: string,
  status: StatusType,
  options: EmbedBuilderOptions = {}
): EmbedBuilder {
  // Define a default hex color as string (Discord.js can parse this)
  let color: ColorResolvable = "#7289DA"; // Discord's blurple

  try {
    // Replace dynamic property access with explicit checks for each status
    if (config?.style) {
      // Use switch statement for safe, controlled access
      switch (status) {
        case "success":
          if (config.style.success?.color) color = config.style.success.color;
          break;
        case "error":
          if (config.style.error?.color) color = config.style.error.color;
          break;
        case "warning":
          if (config.style.warning?.color) color = config.style.warning.color;
          break;
        case "info":
          if (config.style.info?.color) color = config.style.info.color;
          break;
        default:
          // Use default blurple color if status does not match any case
          color = "#7289DA";
          break;
      }
    }

    // Use provided color from options if available
    if (options.color) {
      color = options.color;
    }
  } catch (e) {
    // Fall back to default color on any error
    console.error(`Error resolving color: ${e}`);
  }

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

/**
 * Format an array of strings into embed fields with special handling for section headers
 * Handles formatting and breaking up content to fit within Discord's character limits
 *
 * @param items Array of strings to format into embed fields
 * @param options Optional configuration for formatting behavior
 * @returns Array of formatted embed fields
 */
export function formatArrayToFields(
  items: string[],
  options: {
    maxChars?: number;
    headerPrefix?: string;
    endTrimChars?: number;
  } = {}
): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  const MAX_CHARS = options.maxChars || 1024;
  const headerPrefix = options.headerPrefix || "__**";
  const endTrimChars = options.endTrimChars || 2; // Default trim ", " at end

  let currentValue = "";
  let isHeaderField = false;

  // Process all items
  for (const item of items) {
    // Special handling for section headers
    if (item.startsWith(headerPrefix)) {
      // If we have accumulated content, add it as a field
      if (currentValue) {
        fields.push({
          name: isHeaderField ? currentValue : "\u200B", // Empty name for non-headers
          value: isHeaderField ? "\u200B" : currentValue, // Empty value for headers
        });
        currentValue = "";
      }

      // Set the current value to the header
      currentValue = item;
      isHeaderField = true;
      continue;
    }

    // If this is a normal item after a header
    if (isHeaderField) {
      fields.push({
        name: currentValue,
        value: "\u200B", // Empty space for header value
      });
      currentValue = "";
      isHeaderField = false;
    }

    // Check if adding this item would exceed the character limit
    if (currentValue.length + item.length + 2 > MAX_CHARS) {
      fields.push({
        name: "\u200B",
        value: currentValue,
      });
      currentValue = `${item}, `;
    } else {
      currentValue = `${currentValue}${item}, `;
    }
  }

  // Add the last field if there's content
  if (currentValue) {
    fields.push({
      name: isHeaderField ? currentValue : "\u200B",
      value: isHeaderField
        ? "\u200B"
        : endTrimChars > 0
          ? currentValue.substring(0, currentValue.length - endTrimChars)
          : currentValue,
    });
  }

  return fields;
}

/**
 * Options for paginated embeds
 */
export interface PaginationOptions {
  itemsPerPage: number;
  initialPage?: number;
  showPageIndicator?: boolean;
  buttonStyle?: ButtonStyle;
  timeout?: number; // How long buttons stay active in ms
  ephemeral?: boolean;
}

/**
 * Create a paginated embed with navigation buttons
 * @param interaction The interaction that triggered this command
 * @param embedBuilder Function to build the base embed
 * @param items Array of items to paginate through
 * @param itemRenderer Function that renders each item into an embed field or content
 * @param options Configuration options for pagination
 */
export async function createPaginatedEmbed<T>(
  interaction: CommandInteraction | ButtonInteraction,
  title: string,
  status: StatusType,
  items: T[],
  itemRenderer: (page: T[], pageIndex: number, pageCount: number) => EmbedBuilderOptions,
  options: PaginationOptions = { itemsPerPage: 5 }
): Promise<void> {
  // Check if interaction is still valid
  if (!isInteractionReplyable(interaction, "Paginated Embed")) {
    return;
  }

  if (items.length === 0) {
    // Handle empty case using safe reply
    const embed = createEmbed(title, status, {
      description: "No items found.",
    });

    await safeSendInteractionReply(interaction, { embeds: [embed] }, "Empty Paginated Embed");
    return;
  }

  // Create chunks using the Chunkable utility
  const chunks = Chunkable.from(items, options.itemsPerPage);
  let currentPage = options.initialPage || 0;

  // Function to update the embed with the current page
  const displayPage = async (btnInteraction?: ButtonInteraction): Promise<void> => {
    // Ensure we don't exceed page limits
    if (currentPage >= chunks.pages) currentPage = chunks.pages - 1;
    if (currentPage < 0) currentPage = 0;

    // Set the current page using the proper method
    chunks.setPointer(currentPage); // Use setPointer method instead of direct assignment

    // Render the current page items into embed options
    const embedOptions = itemRenderer(chunks.current, currentPage, chunks.pages);

    // Create the embed
    const embed = createEmbed(title, status, embedOptions);

    // Add page indicator if enabled
    if (options.showPageIndicator !== false && chunks.pages > 1) {
      embed.setFooter({
        text: `Page ${currentPage + 1}/${chunks.pages}${embedOptions.footer ? ` • ${embedOptions.footer}` : ""}`,
      });
    }

    // Create navigation buttons if needed
    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (chunks.pages > 1) {
      const row = new ActionRowBuilder<ButtonBuilder>();

      // Previous page button
      const prevButton = new ButtonBuilder()
        .setCustomId("pagination_prev")
        .setLabel("◀")
        .setStyle(options.buttonStyle || ButtonStyle.Secondary)
        .setDisabled(currentPage === 0);

      // Next page button
      const nextButton = new ButtonBuilder()
        .setCustomId("pagination_next")
        .setLabel("▶")
        .setStyle(options.buttonStyle || ButtonStyle.Secondary)
        .setDisabled(currentPage === chunks.pages - 1);

      row.addComponents(prevButton, nextButton);
      components.push(row);
    }

    const messageOptions = {
      embeds: [embed],
      components: components.length > 0 ? components : [],
    };

    if (btnInteraction) {
      await btnInteraction.update(messageOptions);
    } else if (interaction.deferred) {
      await interaction.editReply(messageOptions);
    } else {
      await interaction.reply({
        ...messageOptions,
        flags: options.ephemeral ? [MessageFlagsBitField.Flags.Ephemeral] : [],
      });
    }

    // Set up collector for button interactions
    if (components.length > 0) {
      const filter = (i: MessageComponentInteraction) =>
        i.user.id === interaction.user.id &&
        ["pagination_prev", "pagination_next"].includes(i.customId);

      const collector = (
        btnInteraction ? btnInteraction : interaction
      ).channel?.createMessageComponentCollector({
        filter,
        time: options.timeout || 120000, // Default 2 minute timeout
      });

      collector?.on("collect", async (i) => {
        if (i.customId === "pagination_prev") {
          currentPage--;
        } else {
          currentPage++;
        }

        await displayPage(i as ButtonInteraction);
      });

      collector?.on("end", async () => {
        // Disable buttons when collector expires
        if (interaction.isRepliable()) {
          try {
            // Create a new ActionRow with disabled buttons
            const disabledComponents = components.map((row) => {
              const newRow = new ActionRowBuilder<ButtonBuilder>();
              // Create new buttons with disabled state
              row.components.forEach((button) => {
                const originalButton = button.data as APIButtonComponentWithCustomId;
                const newButton = new ButtonBuilder()
                  .setCustomId(originalButton.custom_id || "unknown")
                  .setLabel(originalButton.label || "")
                  .setStyle(originalButton.style)
                  .setDisabled(true);

                newRow.addComponents(newButton);
              });
              return newRow;
            });

            await interaction.editReply({ components: disabledComponents });
          } catch {
            // Silently handle errors with disabling buttons
          }
        }
      });
    }
  };

  await displayPage();
}

/**
 * Creates a paginated embed with navigation controls using object parameters
 * @param options Object containing all parameters for pagination
 * @returns The collector for the pagination buttons
 */
export async function createPaginatedEmbedObject<T>({
  interaction,
  data,
  builder,
  flags = 0,
  timeout = 60000,
  previousButton = {
    label: "Previous",
    style: ButtonStyle.Secondary,
  },
  nextButton = {
    label: "Next",
    style: ButtonStyle.Secondary,
  },
}: {
  interaction: CommandInteraction;
  data: T[];
  builder: (currentPage: number, data: T[]) => EmbedBuilder;
  flags?: number;
  timeout?: number;
  previousButton?: {
    label: string;
    style: ButtonStyle;
  };
  nextButton?: {
    label: string;
    style: ButtonStyle;
  };
}): Promise<unknown> {
  if (!isInteractionReplyable(interaction)) {
    return;
  }

  // Create pagination chunks
  const pages = Math.ceil(data.length / 10);
  let currentPage = 0;

  // Create buttons for navigation
  const row = new ActionRowBuilder<ButtonBuilder>();
  const back = new ButtonBuilder()
    .setCustomId("prev")
    .setLabel(previousButton.label)
    .setStyle(previousButton.style)
    .setDisabled(true);

  const next = new ButtonBuilder()
    .setCustomId("next")
    .setLabel(nextButton.label)
    .setStyle(nextButton.style)
    .setDisabled(pages <= 1);

  row.addComponents(back, next);

  // Create the first embed
  const initialEmbed = builder(0, data);

  // Send initial response
  await interaction.editReply({
    embeds: [initialEmbed],
    components: pages > 1 ? [row] : [],
    flags,
  });

  if (pages <= 1) return;

  // Set up collector for pagination
  const filter = (i: MessageComponentInteraction) => i.customId === "prev" || i.customId === "next";

  const collector = interaction.channel?.createMessageComponentCollector({
    filter,
    time: timeout,
  });

  collector?.on("collect", async (i) => {
    // Handle navigation
    if (i.customId === "prev" && currentPage > 0) {
      currentPage--;
    } else if (i.customId === "next" && currentPage < pages - 1) {
      currentPage++;
    }

    // Update button states
    back.setDisabled(currentPage === 0);
    next.setDisabled(currentPage === pages - 1);
    row.setComponents(back, next);

    // Update embed content
    const embed = builder(currentPage, data);

    // Send the update
    await i.update({
      embeds: [embed],
      components: [row],
    });
  });

  collector?.on("end", async () => {
    // Disable buttons when collector expires
    back.setDisabled(true);
    next.setDisabled(true);
    row.setComponents(back, next);

    try {
      await interaction.editReply({
        components: [row],
      });
    } catch {
      // Silently ignore errors updating expired components
    }
  });

  return collector;
}
