import { ActivityType, Client } from "discord.js";
import { db, logger, threads } from "../bot";
import { bumpThreadsRoutine } from "../utilities/routines/ensureVisible";
import { ThreadData } from "src/interfaces/database";
import { handleApiError } from "../utilities/apiErrorHandler";

export default function (client: Client) {
  client.once('shardReady', (shardId) => {
    logger.info(`Client ready on shard ${shardId}`);
  });

  const loadThreads = (): Promise<(void | ThreadData[])[]> => {
    const promises: Promise<ThreadData[] | void>[] = [];

    for (const [, guild] of client.guilds.cache) {
      const dbPromise: Promise<ThreadData[] | void> = db
        .getThreads(guild.id)
        .then((res) => {
          for (const t of res) threads.set(t.id, t);
        })
        .catch((err) => {
          handleApiError(err, loadThreads);
        });

      promises.push(dbPromise);
    }

    return Promise.all(promises);
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

  loadThreads().then((promises) => Promise.allSettled(promises))
    .then((results) => {
      results.forEach((result) => {
        if (result.status === "rejected") {
          logger.warn("[Ready] could not load data for some guilds");
          console.warn(result.reason);
        }
      });
      bumpThreadsRoutine();
      setInterval(bumpThreadsRoutine, 1000 * 60 * 50);
    })
    .catch((e) => {
      logger.warn("[Ready] an unexpected error occurred");
      console.warn(e);
    });
}
