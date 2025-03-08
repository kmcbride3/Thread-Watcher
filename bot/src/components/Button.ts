import {
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentEmojiResolvable,
  Collection,
  MessageFlagsBitField,
} from "discord.js";
import TwGenericComponent from "../interfaces/genericComponent";

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
    // Replace Math.random with a more secure ID generation method
    this.id = `btn_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    this.button = new ButtonBuilder().setLabel(label).setStyle(style).setCustomId(this.id);

    if (!misc) return;
    if (typeof misc.disabled !== "undefined") this.button.setDisabled(misc.disabled);
    if (misc.emoji) this.button.setEmoji(misc.emoji);
    if (misc.url) this.button.setURL(misc.url);
  }

  public middleware(interaction: ButtonInteraction): void {
    if (this.filter && this.callback && this.filter(interaction)) {
      this.callback(interaction);
    } else if (this.callback) {
      this.callback(interaction);
    } else {
      interaction.reply({
        content:
          " <:statusurgent:960959148848214017> This button is no longer valid or you don't have permission to use it.",
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
    }
  }

  public _middleware(interaction: ButtonInteraction): void {
    return this.middleware(interaction);
  }

  close(setDisabled: boolean) {
    ButtonInteractionQueue.delete(this.id);
    if (setDisabled) {
      this.button.setDisabled(true);
    }
  }

  onclick(callback: buttonOnClick) {
    this.callback = callback;
    ButtonInteractionQueue.set(this.id, this);
  }
}
