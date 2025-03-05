import { AnySelectMenuInteraction, StringSelectMenuBuilder, Collection, MessageFlagsBitField } from "discord.js"
import { logger } from "../utilities/logger"
import TwGenericComponent from "../interfaces/genericComponent"

type stringSelectSubmit = ( interaction: AnySelectMenuInteraction ) => void
export type stringSelectFilter = ( interaction: AnySelectMenuInteraction ) => boolean

const StringSelectInteractionQueue: Collection<string, TwStringSelect> = new Collection<string, TwStringSelect>()

export { StringSelectInteractionQueue }


export default class TwStringSelect implements TwGenericComponent<AnySelectMenuInteraction> {
    public select: StringSelectMenuBuilder
    public id: string

    private callback?: stringSelectSubmit
    public filter?: stringSelectFilter

    constructor() {
        
        // There is a chance that an id collision can happen but its very VERY slight
        // esp as the button only exists temporarily
        this.id = `${Math.floor(Math.random() * 10_000_000)}`

        this.select = new StringSelectMenuBuilder()
            .setCustomId(this.id)
    }

    _middleware(interaction: AnySelectMenuInteraction) {
        logger.info("middleware function called")
        if(this.filter && this.callback && this.filter(interaction)) {
            this.callback(interaction)
        } else {
            interaction.reply({
                content: "Nuh uh <:statusurgent:960959148848214017>",
                flags: [MessageFlagsBitField.Flags.Ephemeral]
            })
        }
    }

    close() {
        StringSelectInteractionQueue.delete(this.id)
    }

    onSubmit(callback: stringSelectSubmit) {
        this.callback = callback
        StringSelectInteractionQueue.set(this.id, this)
    }
}