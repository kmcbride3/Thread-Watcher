import { ActivityType, Client, Events } from "discord.js";
import { logger } from "../index";
import { ThreadData } from "../interfaces/database";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { handleApiError } from "../utilities/apiErrorHandler";
import { trackInitState } from "../utilities/debugUtils";
import { ensureVisibleThreads } from "../utilities/routines/threadMonitoring";

export default {
  name: Events.ClientReady,
  once: true,
  execute(client: Client) {
    logger.debug(`Logged in as ${client.user?.tag} to Discord`);
    trackInitState("Bot ready");

    if (
      !serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE) ||
      !serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)
    ) {
      logger.error("Required services not available for ready event");
      return;
    }

    const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
    const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
    const threads = threadManager.getWatchedThreads();

    const promises: Promise<ThreadData[] | undefined>[] = [];

    const loadThreads = async (): Promise<void> => {
      for (const [, guild] of client.guilds.cache) {
        const dbPromise = db
          .getThreads(guild.id)
          .then((res) => {
            for (const t of res)
              threads.set(t.id, {
                id: t.id,
                server: t.server,
                watching: t.watching,
                dueArchive: t.dueArchive,
              });
            return res;
          })
          .catch((err) => {
            handleApiError(err, loadThreads);
            return undefined;
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

    loadThreads()
      .then(() => Promise.allSettled(promises))
      .then((results) => {
        interface LoadThreadsResult {
          status: "fulfilled" | "rejected";
          value?: ThreadData[];
          reason?: unknown;
        }

        (results as LoadThreadsResult[]).forEach((result) => {
          if (result.status === "rejected") {
            logger.warn("[Ready] could not load data for some guilds");
            logger.warn(String(result.reason));
          }
        });
        ensureVisibleThreads();
        setInterval(ensureVisibleThreads, 1000 * 60 * 50);
      })
      .catch((e) => {
        logger.warn("[Ready] an unexpected error occurred");
        logger.warn(e);
      });
  },
};
