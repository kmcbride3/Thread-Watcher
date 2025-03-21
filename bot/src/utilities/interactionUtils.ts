import {
  ActionRowBuilder,
  ButtonInteraction,
  Client,
  Collection,
  CommandInteraction,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { WatchedThread } from "src/interfaces/thread";
import { logger } from "../index";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import { isThreadChannel } from "./threadUtils";

/**
 * Type representing any Discord interaction that can receive a reply
 */
type ReplyableInteraction =
  | CommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction
  | MessageComponentInteraction;

/**
 * Safe checker for whether an interaction can still receive responses
 * @param interaction Any Discord interaction
 * @param context Optional context for logging
 * @returns True if the interaction is still valid and replyable
 */
export function isInteractionReplyable(
  interaction: ReplyableInteraction,
  context?: string
): boolean {
  try {
    // First, check if the interaction object is valid
    if (!interaction || !interaction.id || typeof interaction.replied !== "boolean") {
      logger.warn(`Invalid interaction object ${context ? `in ${context}` : ""}`);
      return false;
    }

    // Then check if it's already been replied to and doesn't support followups
    if (interaction.replied && !interaction.isRepliable()) {
      return false;
    }

    // Check if the interaction is still valid based on Discord.js methods
    return interaction.isRepliable();
  } catch (error) {
    logger.error(
      `Error checking interaction validity ${context ? `in ${context}` : ""}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Options for interaction replies
 */
export interface InteractionReplyContent {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  ephemeral?: boolean;
}

/**
 * Safely reply or edit reply based on interaction state
 * @param interaction The interaction to respond to
 * @param options Reply options (content, embeds, etc.)
 * @param context Optional context for logging
 * @returns True if the response was sent successfully
 */
export async function safeSendInteractionReply(
  interaction: ReplyableInteraction,
  options: InteractionReplyContent,
  context?: string
): Promise<boolean> {
  if (!isInteractionReplyable(interaction, context)) {
    return false;
  }

  return await handleApiError(
    null,
    async () => {
      const replyOptions = {
        content: options.content,
        embeds: options.embeds,
        components: options.components,
        ephemeral: options.ephemeral,
      };

      if (interaction.deferred) {
        const editReplyOptions = {
          content: options.content,
          embeds: options.embeds,
          components: options.components,
        };
        await interaction.editReply(editReplyOptions);
      } else if (!interaction.replied) {
        await interaction.reply(replyOptions);
      } else {
        await interaction.followUp(replyOptions);
      }
      return true;
    },
    {
      retries: 1,
      retryDelay: 500,
      reportAtSeverity: ErrorSeverity.MEDIUM,
      context: `Interaction Reply ${context ? `(${context})` : ""}`,
    }
  ).catch((error) => {
    if (error instanceof Error && error.message.includes("already been acknowledged")) {
      // This is expected in race conditions, don't log as error
      logger.debug(
        `Interaction ${interaction.id} has already been acknowledged ${context ? `in ${context}` : ""}`
      );
    } else {
      logger.error(
        `Failed to send interaction reply ${context ? `in ${context}` : ""}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return false;
  });
}

/**
 * Create a deferred reply wrapper that handles errors gracefully
 * @param interaction The interaction to defer
 * @param ephemeral Whether the response should be ephemeral
 * @param context Optional context for logging
 * @returns True if the defer was successful
 */
export async function safelyDeferReply(
  interaction: ReplyableInteraction,
  ephemeral = false,
  context?: string
): Promise<boolean> {
  if (!isInteractionReplyable(interaction, context)) {
    return false;
  }

  if (interaction.deferred || interaction.replied) {
    return true; // Already deferred or replied
  }

  return await handleApiError(
    null,
    async () => {
      await interaction.deferReply({ ephemeral });
      return true;
    },
    {
      retries: 1,
      retryDelay: 300,
      reportAtSeverity: ErrorSeverity.MEDIUM,
      context: `Defer Interaction ${context ? `(${context})` : ""}`,
    }
  ).catch((error) => {
    logger.error(
      `Failed to defer interaction: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  });
}

/**
 * Helper function to prepare thread data for display in the list command
 * @param threads Collection of threads from ThreadManager
 * @param guildId Current guild ID
 * @returns Formatted thread data ready for display
 */
export async function prepareThreadDisplay(
  threads: Collection<string, WatchedThread>,
  guildId: string,
  client: Client
): Promise<{
  valid: { id: string; name: string; url: string }[];
  invalid: { id: string; reason: string }[];
}> {
  const result: {
    valid: { id: string; name: string; url: string }[];
    invalid: { id: string; reason: string }[];
  } = {
    valid: [],
    invalid: [],
  };

  // Process threads that belong to this guild
  const guildThreads = threads.filter((thread) => thread.server === guildId && thread.watching);

  for (const [threadId, _threadData] of guildThreads.entries()) {
    try {
      const channel = await client.channels.fetch(threadId).catch(() => null);

      if (channel && isThreadChannel(channel)) {
        result.valid.push({
          id: threadId,
          name: channel.name,
          url: `https://discord.com/channels/${guildId}/${threadId}`,
        });
      } else {
        result.invalid.push({
          id: threadId,
          reason: "Thread not found",
        });
      }
    } catch {
      result.invalid.push({
        id: threadId,
        reason: "Error fetching thread",
      });
    }
  }

  return result;
}
