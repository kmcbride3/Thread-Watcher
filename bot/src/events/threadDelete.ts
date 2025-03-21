import { Events, ThreadChannel } from "discord.js";
import { logger } from "../index";
import { ErrorSeverity, handleApiError } from "../utilities/errorSystem";
import { threadManager } from "../utilities/threadManager";
import { isThreadChannel } from "../utilities/threadUtils";

export default {
  name: Events.ThreadDelete,
  once: false,
  async execute(thread: ThreadChannel) {
    try {
      if (!isThreadChannel(thread)) {
        logger.debug(`ThreadDelete event received for non-thread: ${(thread as ThreadChannel).id}`);
        return;
      }

      await handleApiError(
        null,
        async () => {
          // Use removeThreadFromWatch with force=true to ensure complete removal
          const existed = await threadManager.removeThreadFromWatch(thread.id, true);

          if (existed) {
            logger.info(
              `Thread ${thread.name} (${thread.id}) removed from watch list due to deletion`
            );
          } else {
            logger.debug(`Thread ${thread.id} was not being watched when deleted`);
          }
        },
        {
          retries: 1,
          retryDelay: 500,
          reportAtSeverity: ErrorSeverity.LOW,
          context: `ThreadDelete:removeThread(${thread.id})`,
        }
      );
    } catch (error) {
      logger.error(
        `Error in threadDelete event: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};
