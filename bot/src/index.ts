import {
  ShardingManager,
  WebhookClient,
  EmbedBuilder,
  Colors,
  ColorResolvable,
} from "discord.js";
import { client, logger, config, initBot } from "./bot";
import { AutoPoster } from "topgg-autoposter";
import {
  checkCommandChange,
  clearCommands,
  registerCommands
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
  if (checkCommandChange()) {
    logger.debug("no command change found");
  } else {
    try {
      await registerCommands(!args.includes("-local"), config);
    } catch (err) {
      logger.error(`failed to register commands.\n${err}`);
      process.exit(1);
    }
  }

  if (args.includes("-clear_commands")) {
    const local = args.includes("-local");
    await clearCommands(local, config)
      .then(() => {
        logger.done(
          `removed all ${local ? "local" : "global"} commands. Exiting...`,
        );
        process.exit(0);
      })
      .catch((err) => {
        logger.error(
          `failed to remove all ${local ? "local" : "global"} commands.\n${err}`,
        );
        process.exit(1);
      });
  }

  if (args.includes("-reg_commands")) {
    await registerCommands(!args.includes("-local"), config)
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        logger.error(`failed to register commands.\n${err}`);
        process.exit(1);
      });
  }
};

// Global error handlers to log unexpected errors
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
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
});

const originalConsoleError = console.error;
console.error = (...args) => {
  logToFile(`CONSOLE ERROR: ${args.join(' ')}`);
  originalConsoleError(...args);
};

const originalConsoleLog = console.log;
console.log = (...args) => {
  logToFile(`CONSOLE LOG: ${args.join(' ')}`);
  originalConsoleLog(...args);
};

const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  logToFile(`CONSOLE WARN: ${args.join(' ')}`);
  originalConsoleWarn(...args);
};

client.once('ready', async () => {
  logger.info("Bot connected successfully to the designated server(s).");

  await checkCommandRegistryParameters();
  await manager.spawn().catch(async (e) => {
    await handleApiError(e, () => manager.spawn());
    logger.error("Failed to spawn Shard Manager. (dump below)");
    console.error(e);
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

  const killChildren = () => {
    manager.shards.forEach((s) => s.kill());
  };

  process.on("SIGABRT", killChildren);
  process.on("SIGINT", killChildren);
});

const database = getDatabase(DataBases[config.database.type], config);

export { logger, config, webLog, webhookClient };
