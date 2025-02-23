import {
  ShardingManager,
  WebhookClient,
  EmbedBuilder,
  Colors,
  ColorResolvable,
} from "discord.js";
import { client, logger, config, initBot, handleShutdown } from "./bot";
import { AutoPoster } from "topgg-autoposter";
import {
  checkCommandChange,
  clearCommands,
  registerCommands,
  genCommandHash
} from "./utilities/registerCommands";
import start from "./web";
import { DataBases, getDatabase } from "./utilities/database/DatabaseManager";
import scheduleBackups from "./utilities/routines/backup";
import { handleApiError } from "./utilities/apiErrorHandler";
import { logToFile } from "./utilities/fileLogger";

const webhookClient = config.logWebhook
  ? new WebhookClient({ url: config.logWebhook })
  : null;

const webLog = async (
  title: string,
  description: string | null,
  colour: ColorResolvable = Colors.Aqua,
) => {
  if (!webhookClient) return;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setTimestamp(new Date())
    .setColor(colour);
  if (description) embed.setDescription(description);

  const logMessage = `${title}: ${description || ''}`;
  await logToFile(logMessage);

  webhookClient.send({
    username: "Thread-Watcher",
    avatarURL: "https://threadwatcher.xyz/content/icon.png",
    embeds: [embed],
  });
};

const args = process.argv.slice(2);

const checkCommandRegistryParameters = async () => {
  if (!checkCommandChange()) {
    logger.info("No command changes detected, skipping registration.");
  } else {
    try {
      await registerCommands(!args.includes("-local"), config);
      genCommandHash(true); // Update the hash file after registering commands
    } catch (err) {
      logger.error(`Failed to register commands.\n${err}`);
      await handleShutdown("command registration failure");
    }
  }

  if (args.includes("-clear_commands")) {
    const local = args.includes("-local");
    await clearCommands(local, config)
      .then(async () => {
        logger.done(
          `Removed all ${local ? "local" : "global"} commands. Exiting...`,
        );
        await handleShutdown("clear commands");
      })
      .catch(async (err) => {
        logger.error(
          `Failed to remove all ${local ? "local" : "global"} commands.\n${err}`,
        );
        await handleShutdown("clear commands failure");
      });
  }

  if (args.includes("-reg_commands")) {
    await registerCommands(!args.includes("-local"), config)
      .then(() => {
        logger.done("Commands registered successfully.");
      })
      .catch(async (err) => {
        logger.error(`Failed to register commands.\n${err}`);
        await handleShutdown("register commands failure");
      });
  }
};

// Global error handlers to log unexpected errors
process.on("unhandledRejection", async (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
  await handleShutdown("unhandled rejection");
});
process.on("uncaughtException", async (error) => {
  logger.error(`Uncaught Exception: ${error}`);
  await handleShutdown("uncaught exception");
});

const manager = new ShardingManager("./dist/bot.js", {
  token: config.tokens.discord,
  shardArgs: args,
  totalShards: 'auto',
  respawn: true, // Enable automatic respawning of shards
  mode: 'process', // Use process mode for spawning shards
  execArgv: process.execArgv, // Pass exec arguments to the shards
  silent: false, // Enable logging for shard processes
});

// Pass the manager to bot.ts
initBot({ manager });

// Listen for shard errors
manager.on("shardCreate", (shard) => {
  shard.on("error", (error) => {
    logger.error(`Shard ${shard.id} encountered an error: ${error}`);
  });

  shard.on("ready", () => {
    logger.debug(`Shard ${shard.id} is ready.`);
  });

  shard.on("reconnecting", () => {
    logger.debug(`Shard ${shard.id} is reconnecting.`);
  });

  shard.on("resume", () => {
    logger.debug(`Shard ${shard.id} resumed.`);
  });

  shard.on("death", () => {
    logger.debug(`Shard ${shard.id} died.`);
  });

  shard.on("message", (message) => {
    logger.debug(`Shard ${shard.id} received message: ${message}`);
  });

  shard.on("disconnect", () => {
    logger.debug(`Shard ${shard.id} disconnected. Attempting to respawn...`);
    shard.respawn();
  });
});

client.once('ready', async () => {
  await checkCommandRegistryParameters();
  await manager.spawn().catch(async (e) => {
    await handleApiError(e, () => manager.spawn());
    logger.error("Failed to spawn Shard Manager. (dump below)");
    logger.error(e.toString());
    await handleShutdown("shard manager spawn failure");
  });

  if (config.tokens.topgg) {
    logger.info("Using top.gg autoposter");
    AutoPoster(config.tokens.topgg, manager);
  }

  if (config.database.backupInterval) {
    scheduleBackups(database);
  }

  const webserver = () => {
    if (config.statsServer.enabled)
      start(manager, config.statsServer.port, database);
  };

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  let timeOut = setTimeout(() => {}, 100000);

  manager.on("shardCreate", (shard) => {
    if (timeOut) clearTimeout(timeOut);
    logger.done(`Shard with id ${shard.id} spawned!`);
    webLog(`Shard ${shard.id} spawned!`, null);

    shard.on("ready", () => {
      webLog(`Shard ${shard.id} ready!`, null, Colors.Green);
      timeOut = setTimeout(webserver, 1000 * 60 * 2);
    });

    shard.on("death", () => {
      webLog(`Shard ${shard.id} died!`, null, Colors.Red);
    });

    shard.on("disconnect", () => {
      webLog(`Shard ${shard.id} disconnected!`, null, Colors.Orange);
    });

    shard.on("reconnecting", () => {
      webLog(`Shard ${shard.id} is reconnecting!`, null, Colors.DarkGreen);
    });
  });

  const shutdownShards = async () => {
    const results = await manager.broadcastEval(async (client) => {
      try {
        await client.destroy();
        return true;
      } catch (err) {
        logger.error(`Error shutting down shard: ${err}`);
        return false;
      }
    });
    return results.every(result => result);
  };

  const handleShutdown = async (reason: string) => {
    logger.info(`Shutdown initiated due to: ${reason}`);
    const shutdownTimeout = setTimeout(() => {
      logger.error("Shutdown process taking too long, forcing exit...");
      process.exit(1);
    }, 10000); // 10 seconds timeout

    try {
      const success = await shutdownShards();
      clearTimeout(shutdownTimeout);
      if (success) {
        logger.done("All shards shut down successfully. Main process exiting.");
        process.exit(0);
      } else {
        logger.error("Error during shutdown: Not all shards shut down successfully.");
        process.exit(1);
      }
    } catch (err) {
      logger.error(`Error during shutdown: ${err}`);
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  };

  // Handle SIGABRT, SIGINT, and SIGTERM signals
  process.on("SIGABRT", async () => await handleShutdown("SIGABRT"));
  process.on("SIGINT", async () => await handleShutdown("SIGINT"));
  process.on("SIGTERM", async () => await handleShutdown("SIGTERM"));
});

const database = getDatabase(DataBases[config.database.type], config);

export { logger, config, webLog, webhookClient };
