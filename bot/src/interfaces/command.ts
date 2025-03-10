import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  PermissionResolvable,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { EmbedBuilderFunction, EmbedBuilderOptions } from "../utilities/embedUtils";

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

// Export baseEmbedOptions as an alias to EmbedBuilderOptions for backward compatibility
export type baseEmbedOptions = EmbedBuilderOptions;
export type BuildBaseEmbedFunction = EmbedBuilderFunction;

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
    buildBaseEmbed: EmbedBuilderFunction
  ) => Promise<void>;

  execute?: (
    interaction: ChatInputCommandInteraction,
    buildBaseEmbed: EmbedBuilderFunction
  ) => Promise<void>;

  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}
