import { ShardingManager } from "discord.js";
import express, { Request, Response } from "express";
import { config, logger } from "../index";
import { Database } from "../interfaces/database";

let started = false;

export default function start(manager: ShardingManager, port: number, database: Database) {
  if (started) return;

  const app = express();

  interface statsData {
    guildCount: number;
    userCount: number;
    shards: {
      id: number;
      status: number;
      ping: number;
      uptime: number;
      guilds: number;
    }[];
    threads: number;
    channels: number;
    votes: number;
  }

  // Initialize stats object
  const stats: statsData = {
    guildCount: 0,
    userCount: 0,
    threads: 0,
    channels: 0,
    votes: 0,
    shards: [],
  };

  const getStats = async (m: ShardingManager) => {
    const promises = [
      m.broadcastEval((c) => c.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0)),
      m.broadcastEval((client) => [
        client.shard?.ids,
        client.ws.status,
        client.ws.ping,
        client.uptime,
        client.guilds.cache.size,
      ]),
    ];

    const res = await Promise.all(promises);

    let userCount = 0;
    for (const gc of res[0]) {
      if (typeof gc === "number") userCount += gc;
    }

    return { userCount, shards: res[1] };
  };

  // Helper function to fetch Top.gg votes
  function getTopggVotes(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!config.tokens.topgg || !config.clientID) {
        resolve(0);
        return;
      }

      fetch(`https://top.gg/api/bots/${config.clientID}`, {
        headers: [["Authorization", config.tokens.topgg]],
      })
        .then((res) => {
          res
            .json()
            .then((res) => {
              if (res && res.points && typeof res.points === "number") resolve(res.monthlyPoints);
              else resolve(0);
            })
            .catch((e) => reject(e));
        })
        .catch((e) => reject(e));
    });
  }

  let timesRan = 0;

  const statsFunc = () => {
    if (timesRan % 2 === 0 && config.tokens.topgg && config.tokens.topgg.length > 0) {
      getTopggVotes()
        .then((r) => {
          stats.votes = r;
        })
        .catch((e) => {
          logger.warn("could not get top.gg votes: " + e);
        });
    }

    database.getNumberOfThreads().then((r) => {
      stats.threads = r;
    });

    database.getNumberOfChannels().then((r) => {
      stats.channels = r;
    });

    getStats(manager).then((r) => {
      stats.userCount = r.userCount;

      stats.guildCount = 0;
      stats.shards = [];
      for (const shard of r.shards) {
        if (!(shard instanceof Array) || shard.length !== 5) continue;
        if (typeof shard[4] === "number") stats.guildCount += shard[4];
        stats.shards.push({
          id: shard[0] instanceof Array ? shard[0][0] : 0,
          status: typeof shard[1] === "number" ? shard[1] : 0,
          ping: typeof shard[2] === "number" ? shard[2] : 0,
          uptime: typeof shard[3] === "number" ? shard[3] : 0,
          guilds: typeof shard[4] === "number" ? shard[4] : 0,
        });
      }
    });
    timesRan += 1;
  };

  setTimeout(statsFunc, 1000);
  setInterval(statsFunc, 1000 * 60);

  app.get("/getShard", (req: Request, res: Response): void => {
    try {
      const query = req.query as Record<string, string | string[] | undefined>;

      const guildParam = query.guild;

      if (guildParam === undefined) {
        res.status(400).send("missing param guild");
        return;
      }

      let guildId: string;

      if (Array.isArray(guildParam)) {
        guildId = guildParam[0] || "";
      } else {
        guildId = guildParam;
      }

      if (!/^\d{17,20}$/.test(guildId)) {
        res.status(400).send("invalid guild id");
        return;
      }

      const contextObj = { guildId: guildId };

      manager
        .broadcastEval(
          (c: import("discord.js").Client, context: { guildId: string }) => {
            return [c.shard?.ids, c.guilds.cache.has(context.guildId)];
          },
          { context: contextObj }
        )
        .then((result) => {
          for (const row of result) {
            const shardId = row[0] instanceof Array ? row[0][0] : 69;

            if (typeof row[1] === "boolean" && row[1]) {
              res.send({ found: true, shard: shardId });
              return;
            }
          }
          res.json({ found: false, shard: -1 });
        })
        .catch((err) => {
          logger.error(`Error in getShard endpoint: ${err}`);
          res.status(500).send("something went wrong");
        });
    } catch (err) {
      logger.error(`Unexpected error in getShard endpoint: ${err}`);
      res.status(500).send("Internal server error");
    }
  });

  app.get("/stats", (_req: Request, res: Response) => {
    res.json(stats);
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.listen(port, () => {
    logger.done(`Stats server listening on port ${port}`);
    started = true;
  });
}
