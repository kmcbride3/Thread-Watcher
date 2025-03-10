import {
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Collection,
  ComponentEmojiResolvable,
  MessageFlagsBitField,
} from "discord.js";
import { logger } from "../index";
import TwGenericComponent from "../interfaces/genericComponent";
import { handleApiError } from "../utilities/apiErrorHandler";

type buttonOnClick = (interaction: ButtonInteraction) => void;
export type buttonFilter = (interaction: ButtonInteraction) => boolean;

const ButtonInteractionQueue: Collection<string, TwButton> = new Collection<string, TwButton>();

export { ButtonInteractionQueue };

/**
 * I am truly the smartest brogrammer that has ever lived
 * so this mf master class that i was cooking up at 0230 will construct the button and make a random id and take a callback
 * after the callback is taken it will be added to the ButtonInteractionQueue Map and will be keyed by the button id
 * and when a button interaction that matches the id of the button pops into interactionCreate it will call the onclick func.
 */
export default class TwButton implements TwGenericComponent<ButtonInteraction> {
  public button: ButtonBuilder;
  public id: string;

  private callback?: buttonOnClick;
  public filter?: buttonFilter;

  constructor(
    label: string,
    style: ButtonStyle,
    misc?: {
      disabled?: boolean;
      emoji?: ComponentEmojiResolvable;
      url?: string;
    }
  ) {
    this.id = `btn_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    this.button = new ButtonBuilder().setLabel(label).setStyle(style).setCustomId(this.id);

    if (!misc) return;
    if (typeof misc.disabled !== "undefined") this.button.setDisabled(misc.disabled);
    if (misc.emoji) this.button.setEmoji(misc.emoji);
    if (misc.url) this.button.setURL(misc.url);
  }

  public async middleware(interaction: ButtonInteraction): Promise<void> {
    try {
      if (this.filter && this.callback && this.filter(interaction)) {
        await handleApiError(
          null,
          async () => {
            if (this.callback) await this.callback(interaction);
          },
          2,
          500
        );
      } else if (this.callback) {
        await handleApiError(
          null,
          async () => {
            if (this.callback) await this.callback(interaction);
          },
          2,
          500
        );
      } else {
        await interaction.reply({
          content:
            " <:statusurgent:960959148848214017> This button is no longer valid or you don't have permission to use it.",
          flags: [MessageFlagsBitField.Flags.Ephemeral],
        });
      }
    } catch (error) {
      logger.error(`Button middleware error for ${this.id}: ${error}`);

      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({
            content: "An error occurred while processing this button.",
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        } catch (replyError) {
          logger.error(`Failed to send error response: ${replyError}`);
        }
      }
    }
  }

  public _middleware(interaction: ButtonInteraction): void {
    this.middleware(interaction).catch((err) =>
      logger.error(`Uncaught error in button middleware: ${err}`)
    );
  }

  close(setDisabled = false): void {
    ButtonInteractionQueue.delete(this.id);
    if (setDisabled) {
      this.button.setDisabled(true);
    }
  }

  onclick(callback: buttonOnClick): void {
    this.callback = callback;
    ButtonInteractionQueue.set(this.id, this);
  }
}
