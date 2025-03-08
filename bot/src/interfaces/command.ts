import {
  ColorResolvable,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  PermissionResolvable,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
  ActionRowBuilder,
  SlashCommandOptionsOnlyBuilder,
  MessageActionRowComponentBuilder,
} from "discord.js";

export enum statusType {
  error = "error",
  success = "success",
  info = "info",
  warning = "warning",
}

export interface builderField<T = unknown> {
  name: string;
  value: T | string;
  inline?: boolean;
}

export interface baseEmbedOptions {
  description?: string;
  color?: ColorResolvable;
  fields?: { name: string; value: string | number; inline?: boolean }[];
  flags?: number[];
  showAuthor?: boolean;
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  noSend?: boolean;
}

// Define the type for the buildBaseEmbed function
export type BuildBaseEmbedFunction = (
  title: string,
  status?: statusType,
  options?: baseEmbedOptions
) => EmbedBuilder;

export interface Gatekeeping {
  ownerOnly: boolean;
  userPermissions?: PermissionResolvable[];
  botPermissions?: PermissionResolvable[];
  devServerOnly: boolean;
}

export interface Command {
  data:
    | Omit<SlashCommandBuilder, "addSubcommandGroup" | "addSubcommand">
    | SlashCommandSubcommandsOnlyBuilder
    | SlashCommandOptionsOnlyBuilder;
  gatekeeping?: Gatekeeping;
  externalOptions?: unknown[];
  run: (
    interaction: ChatInputCommandInteraction,
    buildBaseEmbed: (title: string, status: statusType, misc?: baseEmbedOptions) => EmbedBuilder
  ) => Promise<void>;

  execute?: (
    interaction: ChatInputCommandInteraction,
    buildBaseEmbed: (title: string, status: statusType, misc?: baseEmbedOptions) => EmbedBuilder
  ) => Promise<void>;

  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}
