import { Message } from "discord.js";
import { logger } from "../bot";
import { threads } from "../bot";
import { bumpAutoTime } from "../utilities/threadActions";

export default function() {
    return function(message: Message) {
        if(!message.channel || !message.channel.isThread() || !threads.has(message.channelId)) return
        bumpAutoTime(message.channel)
            .catch((e) => {
                logger.error(`failed to bump thread with id ${message.channelId}: ${e}`)
            })
    }
}