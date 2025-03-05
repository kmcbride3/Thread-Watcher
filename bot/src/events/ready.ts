import { Client, Events, ActivityType } from "discord.js";
import { logger, db } from "../index";
import { threads } from "../bot";
import { bumpThreadsRoutine } from "../utilities/routines/ensureVisible";
import { ThreadData } from "src/interfaces/database";
import { handleApiError } from "../utilities/apiErrorHandler";
import { trackInitState } from "../utilities/debugUtils";

export default {
  name: Events.ClientReady,
  once: true,
  execute(client: Client) {
    logger.done(`Ready! Logged in as ${client.user?.tag}`);
    trackInitState("Bot ready");

    const promises: Promise<ThreadData[] | void>[] = [];

    const loadThreads = async (): Promise<void> => {
      for (const [, guild] of client.guilds.cache) {
        const dbPromise: Promise<ThreadData[] | void> = db
          .getThreads(guild.id)
          .then((res) => {
            for (const t of res) threads.set(t.id, {
              id: t.id,
              server: t.server,
              watching: t.watching,
              dueArchive: t.dueArchive
            });
          })
          .catch((err) => {
            handleApiError(err, loadThreads);
          });

        promises.push(dbPromise);
      }

      await Promise.all(promises);
    };

    const setPresence = () => {
      if (client.user) {
        client.user.setPresence({
          activities: [{ name: "your threads 🧵", type: ActivityType.Watching }],
          status: "online",
        });
      }
    };

    setPresence();
    setInterval(setPresence, 1000 * 60 * 60);

    loadThreads().then(() => Promise.allSettled(promises))
      .then((results) => {
        interface LoadThreadsResult {
          status: "fulfilled" | "rejected";
          value?: ThreadData[] | void;
          reason?: unknown;
        }

        (results as LoadThreadsResult[]).forEach((result) => {
          if (result.status === "rejected") {
            logger.warn("[Ready] could not load data for some guilds");
            logger.warn(String(result.reason));
          }
        });
        bumpThreadsRoutine();
        setInterval(bumpThreadsRoutine, 1000 * 60 * 50);
      })
      .catch((e) => {
        logger.warn("[Ready] an unexpected error occurred");
        logger.warn(e);
      });
  }
};
