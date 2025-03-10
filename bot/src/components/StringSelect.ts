import {
  AnySelectMenuInteraction,
  Collection,
  MessageFlagsBitField,
  StringSelectMenuBuilder,
} from "discord.js";
import TwGenericComponent from "../interfaces/genericComponent";
import { handleApiError } from "../utilities/apiErrorHandler";
import { logger } from "../utilities/logger";

type stringSelectSubmit = (interaction: AnySelectMenuInteraction) => void;
export type stringSelectFilter = (interaction: AnySelectMenuInteraction) => boolean;

const StringSelectInteractionQueue = new Collection<string, TwStringSelect>();

export { StringSelectInteractionQueue };

export default class TwStringSelect implements TwGenericComponent<AnySelectMenuInteraction> {
  public select: StringSelectMenuBuilder;
  public id: string;

  private callback?: stringSelectSubmit;
  public filter?: stringSelectFilter;

  constructor() {
    this.id = `sel_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    this.select = new StringSelectMenuBuilder().setCustomId(this.id);
  }

  public async middleware(interaction: AnySelectMenuInteraction): Promise<void> {
    try {
      logger.trace(`StringSelect middleware called for ID ${this.id}`);

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
          content: "Nuh uh <:statusurgent:960959148848214017>",
          flags: [MessageFlagsBitField.Flags.Ephemeral],
        });
      }
    } catch (error) {
      logger.error(`StringSelect middleware error for ${this.id}: ${error}`);

      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({
            content: "An error occurred while processing this selection.",
            flags: [MessageFlagsBitField.Flags.Ephemeral],
          });
        } catch (replyError) {
          logger.error(`Failed to send error response: ${replyError}`);
        }
      }
    }
  }

  public _middleware(interaction: AnySelectMenuInteraction): void {
    this.middleware(interaction).catch((err) =>
      logger.error(`Uncaught error in select middleware: ${err}`)
    );
  }

  close(): void {
    StringSelectInteractionQueue.delete(this.id);
  }

  onSubmit(callback: stringSelectSubmit): void {
    this.callback = callback;
    StringSelectInteractionQueue.set(this.id, this);
  }
}
