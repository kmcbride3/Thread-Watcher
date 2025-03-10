import { Events, ThreadChannel } from "discord.js";
import { logger } from "../index";
import { threadManager } from "../utilities/threadManager";
import { isThreadChannel } from "../utilities/threadUtils";

export default {
  name: Events.ThreadDelete,
  once: false,
  execute(thread: ThreadChannel) {
    try {
      if (!isThreadChannel(thread)) {
        logger.debug(`ThreadDelete event received for non-thread: ${(thread as ThreadChannel).id}`);
        return;
      }

      const existed = threadManager.unwatchThread(thread.id);

      if (existed) {
        logger.debug(`Thread ${thread.id} removed from watched threads due to deletion`);
      }
    } catch (error) {
      logger.error(
        `Error in threadDelete event: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};
