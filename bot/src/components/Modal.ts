import {
  ActionRowBuilder,
  Collection,
  MessageFlagsBitField,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { logger } from "../index";
import TwGenericComponent from "../interfaces/genericComponent";
import { handleApiError } from "../utilities/apiErrorHandler";

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
    this.id = `mdl_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    this.modal = new ModalBuilder().setTitle(label).setCustomId(this.id);
  }

  addInput(label: string, id: string, style: TextInputStyle = TextInputStyle.Short): void {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style);

    const actionRow = new ActionRowBuilder<ModalActionRowComponentBuilder>();
    actionRow.addComponents(input);

    this.modal.setComponents(actionRow);
  }

  public async middleware(interaction: ModalSubmitInteraction): Promise<void> {
    try {
      if (this.filter && this.callback && this.filter(interaction)) {
        await handleApiError(
          null,
          async () => {
            if (this.callback) await this.callback(interaction);
          },
          2, // retry count
          500 // retry delay
        );
      } else if (this.callback) {
        await handleApiError(
          null,
          async () => {
            if (this.callback) await this.callback(interaction);
          },
          2, // retry count
          500 // retry delay
        );
      } else {
        await interaction.reply({
          content:
            "<:statusurgent:960959148848214017> This form is no longer valid or you don't have permission to submit it.",
          flags: [MessageFlagsBitField.Flags.Ephemeral],
        });
      }
    } catch (error) {
      logger.error(`Modal middleware error for ${this.id}: ${error}`);

      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({
            content: "An error occurred while processing this form.",
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        } catch (replyError) {
          logger.error(`Failed to send error response: ${replyError}`);
        }
      }
    }
  }

  public _middleware(interaction: ModalSubmitInteraction): void {
    this.middleware(interaction).catch((err) =>
      logger.error(`Uncaught error in modal middleware: ${err}`)
    );
  }

  close(): void {
    ModalInteractionQueue.delete(this.id);
  }

  onSubmit(callback: modalSubmit): void {
    this.callback = callback;
    ModalInteractionQueue.set(this.id, this);
  }
}
