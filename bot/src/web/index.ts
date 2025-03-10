import { ShardingManager } from "discord.js";
import express, { NextFunction, Request, Response } from "express";
import { config, logger } from "../index";
import { Database } from "../interfaces/database";
import { ErrorSeverity, handleApiError } from "../utilities/errorSystem";
import { formatDuration, formatFileSize, truncate } from "../utilities/formatUtils";
import { rateLimitManager } from "../utilities/rateLimitManager";

let started = false;

/**
 * Web rate limit middleware that integrates with our centralized rate limit manager
 */
function webRateLimitMiddleware(maxRequestsPerMinute = 30) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const route = `web/${req.path}/${ip}`;

      if (rateLimitManager.isRateLimited(route)) {
        const resetTime = rateLimitManager.getRateLimitedUntil(route) || Date.now() + 5000;
        const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);

        res.set({
          "Retry-After": retryAfter.toString(),
          "X-RateLimit-Limit": maxRequestsPerMinute.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": Math.ceil(resetTime / 1000).toString(),
        });

        logger.warn(`Rate limiting web request: ${req.path} from ${truncate(ip, 20)}`);

        res.status(429).json({
          error: "Too many requests",
          retryAfter,
          retryAt: new Date(resetTime).toISOString(),
        });
        return;
      }

      rateLimitManager
        .waitForRateLimit(route)
        .then(() => next())
        .catch((err) => {
          logger.error(`Rate limit error: ${err}`);
          next();
        });
    } catch (error) {
      logger.error(`Error in rate limit middleware: ${error}`);
      next();
    }
  };
}

export default function start(manager: ShardingManager, port: number, database: Database) {
  if (started) return null;

  const app = express();

  app.use(webRateLimitMiddleware(30)); // 30 requests per minute

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
    return await handleApiError(
      "Failed to fetch shard stats",
      async () => {
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
      },
      {
        retries: 3,
        retryDelay: 1000,
        reportAtSeverity: ErrorSeverity.HIGH,
        context: "Web Stats - Shard Data",
      }
    );
  };

  // Helper function to fetch Top.gg votes
  async function getTopggVotes(): Promise<number> {
    if (!config.tokens.topgg || !config.clientID) {
      return 0;
    }

    return await handleApiError(
      "Failed to fetch Top.gg votes",
      async () => {
        await rateLimitManager.waitForRateLimit("external/topgg");

        const response = await fetch(`https://top.gg/api/bots/${config.clientID}`, {
          headers: { Authorization: config.tokens.topgg },
        });

        if (!response.ok) {
          throw new Error(`Top.gg API returned ${response.status}`);
        }

        const data = await response.json();
        return data?.monthlyPoints || 0;
      },
      {
        retries: 1,
        retryDelay: 2000,
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: "Web Stats - Top.gg API",
      }
    ).catch((error) => {
      logger.warn(`Could not get top.gg votes: ${error}`);
      return 0;
    });
  }

  let timesRan = 0;

  const statsFunc = async () => {
    try {
      await rateLimitManager.waitForRateLimit("web/stats/update");

      // Only fetch Top.gg votes periodically to avoid API rate limits
      if (timesRan % 2 === 0 && config.tokens.topgg && config.tokens.topgg.length > 0) {
        stats.votes = await getTopggVotes();
      }

      await Promise.all([
        handleApiError(
          "Failed to fetch thread count",
          async () => {
            await rateLimitManager.waitForRateLimit("db/stats/threads");
            stats.threads = await database.getNumberOfThreads();
          },
          {
            retries: 2,
            reportAtSeverity: ErrorSeverity.LOW,
            context: "Web Stats - Thread Count",
          }
        ),
        handleApiError(
          "Failed to fetch channel count",
          async () => {
            await rateLimitManager.waitForRateLimit("db/stats/channels");
            stats.channels = await database.getNumberOfChannels();
          },
          {
            retries: 2,
            reportAtSeverity: ErrorSeverity.LOW,
            context: "Web Stats - Channel Count",
          }
        ),
      ]);

      const shardStats = await getStats(manager);

      stats.userCount = shardStats.userCount;
      stats.guildCount = 0;
      stats.shards = [];

      for (const shard of shardStats.shards) {
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

      timesRan += 1;
    } catch (error) {
      logger.error(`Error updating stats: ${error}`);
    }
  };

  setTimeout(statsFunc, 1000);
  setInterval(statsFunc, 1000 * 60);

  app.get("/getShard", async (req: Request, res: Response): Promise<void> => {
    try {
      await rateLimitManager.waitForRateLimit("web/getShard");

      const query = req.query as Record<string, string | string[] | undefined>;
      const guildParam = query.guild;

      if (guildParam === undefined) {
        res.status(400).json({
          error: "Missing parameter",
          message: "Required query parameter 'guild' is missing",
        });
        return;
      }

      let guildId: string;

      if (Array.isArray(guildParam)) {
        guildId = guildParam[0] || "";
      } else {
        guildId = guildParam;
      }

      if (!/^\d{17,20}$/.test(guildId)) {
        res.status(400).json({
          error: "Invalid parameter",
          message: "Guild ID must be a valid Discord ID (17-20 digits)",
        });
        return;
      }

      const contextObj = { guildId };

      const result = await handleApiError(
        "Failed to get shard for guild",
        async () => {
          await rateLimitManager.waitForRateLimit("sharding/broadcastEval");

          return await manager.broadcastEval(
            (c: import("discord.js").Client, context: { guildId: string }) => {
              return [c.shard?.ids, c.guilds.cache.has(context.guildId)];
            },
            { context: contextObj }
          );
        },
        {
          retries: 2,
          retryDelay: 1000,
          reportAtSeverity: ErrorSeverity.MEDIUM,
          context: "Web getShard Endpoint",
        }
      );

      for (const row of result) {
        const shardId = row[0] instanceof Array ? row[0][0] : null;

        if (typeof row[1] === "boolean" && row[1] && shardId !== null) {
          res.json({ found: true, shard: shardId });
          return;
        }
      }

      res.json({ found: false, shard: -1 });
    } catch (err) {
      logger.error(`Error in getShard endpoint: ${err}`);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to process request",
      });
    }
  });

  app.get("/stats", (_req: Request, res: Response) => {
    res.json(stats);
  });

  app.get("/health", (_req: Request, res: Response) => {
    const uptime = process.uptime();
    const memoryMb = Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;

    res.json({
      status: "ok",
      uptime,
      uptimeFormatted: formatDuration(uptime * 1000),
      memory: memoryMb,
      memoryFormatted: formatFileSize(process.memoryUsage().rss),
      startedAt: new Date(Date.now() - uptime * 1000).toISOString(),
      threadCount: stats.threads,
      serverCount: stats.guildCount,
    });
  });

  const server = app.listen(port, () => {
    logger.done(`Stats server listening on port ${port}`);
    started = true;
  });

  server.on("error", (err) => {
    logger.error(`Web server error: ${err}`);
  });

  return app;
}
