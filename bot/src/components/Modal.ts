import {
  ActionRowBuilder,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  TextInputBuilder,
  ModalSubmitInteraction,
  TextInputStyle,
  Collection,
  MessageFlagsBitField,
} from "discord.js";
import TwGenericComponent from "../interfaces/genericComponent";

type modalSubmit = (interaction: ModalSubmitInteraction) => void;
export type modalFilter = (interaction: ModalSubmitInteraction) => boolean;

const ModalInteractionQueue: Collection<string, TwModal> = new Collection<string, TwModal>();

export { ModalInteractionQueue };

/**
 * I am truly the smartest brogrammer that has ever lived
 * so this mf master class that i was cooking up at 0230 will construct the button and make a random id and take a callback
 * after the callback is taken it will be added to the ButtonInteractionQueue Map and will be keyed by the button id
 * and when a button interaction that matches the id of the button pops into interactionCreate it will call the onclick func.
 */
export default class TwModal implements TwGenericComponent<ModalSubmitInteraction> {
  public modal: ModalBuilder;
  public id: string;

  private callback?: modalSubmit;
  public filter?: modalFilter;

  constructor(label: string) {
    // Replace Math.random with a more secure ID generation method
    this.id = `mdl_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    this.modal = new ModalBuilder().setTitle(label).setCustomId(this.id);
  }

  addInput(label: string, id: string, style: TextInputStyle = TextInputStyle.Short) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style);

    const actionRow = new ActionRowBuilder<ModalActionRowComponentBuilder>();
    actionRow.addComponents(input);

    this.modal.setComponents(actionRow);
  }

  public middleware(interaction: ModalSubmitInteraction): void {
    if (this.filter && this.callback && this.filter(interaction)) {
      this.callback(interaction);
    } else if (this.callback) {
      this.callback(interaction);
    } else {
      interaction.reply({
        content:
          "<:statusurgent:960959148848214017> This form is no longer valid or you don't have permission to submit it.",
        flags: [MessageFlagsBitField.Flags.Ephemeral],
      });
    }
  }

  public _middleware(interaction: ModalSubmitInteraction): void {
    return this.middleware(interaction);
  }

  close() {
    ModalInteractionQueue.delete(this.id);
  }

  onSubmit(callback: modalSubmit) {
    this.callback = callback;
    ModalInteractionQueue.set(this.id, this);
  }
}
