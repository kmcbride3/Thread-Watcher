import {
  ShardingManager,
  Shard,
  WebhookClient,
  EmbedBuilder,
  Colors,
  ColorResolvable,
  Client,
  GatewayIntentBits,
} from "discord.js";
import {
  acquireInitLock,
  createMainProcessLock,
  createShardProcessLock,
  removeProcessLock,
  cleanupStaleLocks,
  ProcessType,
} from "./utilities/startup";
import { trackInitState, logMemoryUsage } from "./utilities/debugUtils";
import { AutoPoster } from "topgg-autoposter";
import { getConfig } from "./utilities/cnf/index";
import {
  checkCommandChange,
  clearCommands,
  registerCommands,
  genCommandHash,
} from "./utilities/registerCommands";
import start from "./web";
import { initializeDatabase } from "./utilities/database/DatabaseManager";
import scheduleBackups from "./utilities/routines/backup";
import loadCommands from "./utilities/loadCommands";
import { logger, logToFile, initLogger } from "./utilities/logger";
import { initBot } from "./bot";
import { isShard, processState, ProcessRole, getShardId } from "./utilities/processState";
import { rateLimitManager } from "./utilities/rateLimitManager";
import reloadCommands from "./utilities/routines/reloadCommands";
import { Database } from "./interfaces/database";

const isShardProcess = isShard();

// Hide the initializing message unless INIT_DEBUG is set
const showInitMessages = Boolean(process.env.INIT_DEBUG);

// Add diagnostic logging to help debug process issues
if (showInitMessages) {
  console.log(`[${process.pid}] Process starting with argv: ${process.argv.join(" ")}`);
  console.log(
    `[${process.pid}] Environment variables: IS_SHARD=${process.env.IS_SHARD || "undefined"}, SHARD_ID=${process.env.SHARD_ID || "undefined"}`
  );
  console.log(`[${process.pid}] isShard() returns: ${isShardProcess}`);
}

// Only show the Thread-Watcher startup message once in the main process
if (!isShardProcess) {
  console.log("Starting Thread-Watcher application...");
}

// Safe logger function that works even before the logger is initialized
const safeLog = (level: string, message: string): void => {
  // If logger is initialized, use it
  if (logger && typeof logger[level as keyof typeof logger] === "function") {
    (logger[level as keyof typeof logger] as (message: string) => void)(message);
  } else {
    // Fallback to console
    const timestamp = new Date().toISOString();
    if (level === "error") {
      console.error(`${timestamp} [ERROR] ${message}`);
    } else if (level === "warn") {
      console.warn(`${timestamp} [WARN] ${message}`);
    } else {
      console.log(`${timestamp} [${level.toUpperCase()}] ${message}`);
    }
  }
};

let manager: ShardingManager;
let shuttingDown = false;
const shards: Shard[] = [];
let shardsDestroyed = false;
// Add global initialization tracking
let hasInitialized = false;

export let db: Database;

const config = getConfig();
export { config };

// Helper functions
const destroyShards = () => {
  if (shardsDestroyed) return;
  shardsDestroyed = true;
  for (const shard of shards) {
    if (shard.process && !shard.process.killed) {
      try {
        shard.kill();
        safeLog("debug", `Killed shard ${shard.id}`);
      } catch (err) {
        safeLog("error", `Failed to kill shard ${shard.id}: ${err}`);
      }
    }
  }
};

const handleMainShutdown = async (reason: string): Promise<void> => {
  if (shuttingDown) return; // Prevent multiple shutdown attempts

  safeLog("info", `[${processState.role.toUpperCase()}] Shutdown initiated due to: ${reason}`);
  trackInitState(`Main process shutdown started: ${reason}`);
  shuttingDown = true;

  if (manager) {
    // Notify all shards to shut down
    safeLog(
      "debug",
      `[${processState.role.toUpperCase()}] Sending shutdown signal to ${manager.shards.size} shards`
    );
    try {
      for (const shard of manager.shards.values()) {
        if (shard.process && !shard.process.killed) {
          shard
            .send("shutdown")
            .catch((err) =>
              safeLog("error", `Failed to send shutdown signal to shard ${shard.id}: ${err}`)
            );
        }
      }
    } catch (err) {
      safeLog("error", `Error sending shutdown signals to shards: ${err}`);
    }

    // Give shards time to shut down gracefully
    safeLog(
      "debug",
      `[${processState.role.toUpperCase()}] Waiting for shards to shut down (5s timeout)`
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // Close the database connection if available
  if (db && typeof db.close === "function") {
    safeLog("debug", `[${processState.role.toUpperCase()}] Closing database connection...`);
    try {
      await db.close();
    } catch (err) {
      safeLog("error", `Error closing database: ${err}`);
    }
  }

  // Remove the process lock file
  removeProcessLock(ProcessType.MAIN);

  safeLog("done", `[${processState.role.toUpperCase()}] Shutdown complete. Exiting process.`);
  trackInitState("Main process exit");
  process.exit(0);
};

const webLog = async (
  title: string,
  description: string | null,
  colour: ColorResolvable = Colors.Aqua
) => {
  const webhookClient = config.logWebhook
    ? new WebhookClient({ url: config.logWebhook as string })
    : null;
  if (!webhookClient) return;
  const embed = new EmbedBuilder().setTitle(title).setTimestamp(new Date()).setColor(colour);
  if (description) embed.setDescription(description);
  const logMessage = `${title}: ${description || ""}`;
  // Call logToFile to persist logs
  await logToFile(logMessage);
  webhookClient.send({
    username: "Thread-Watcher",
    avatarURL: "https://threadwatcher.xyz/content/icon.png",
    embeds: [embed],
  });
};

// Exported initialize function handling both shard and main processes.
export const initialize = async (): Promise<void> => {
  // Prevent multiple initializations within the same process
  if (!acquireInitLock()) {
    safeLog("warn", `Process ${process.pid} tried to initialize again, ignoring.`);
    return;
  }

  // Determine process type and set appropriate state
  if (isShard()) {
    // Set process role for shard
    processState.role = ProcessRole.SHARD;
    processState.shardId = getShardId();

    // Set environment variable for backward compatibility
    process.env.IS_SHARD = "true";

    // Create shard-specific lock file with the shard ID
    if (!createShardProcessLock(processState.shardId)) {
      safeLog("error", "Failed to create shard lock file. Process may be unstable.");
    }

    trackInitState(`Shard ${processState.shardId} process starting`);
  } else {
    // Set process role for main
    processState.role = ProcessRole.MAIN;

    // Clean up any stale locks first
    cleanupStaleLocks();

    // Try to create main process lock, exit if another main process is already running
    if (!createMainProcessLock()) {
      safeLog("error", "Another main process is already running. Exiting.");
      process.exit(1);
    }

    trackInitState("Main process starting");
    // Only log this debug message if showInitMessages is set
    if (showInitMessages) {
      safeLog("debug", `Main process successfully acquired lock with PID ${process.pid}`);

      logMemoryUsage();
    }
  }

  initLogger({
    logLevel: config.logLevel,
    logBold: config.logBold || false,
    logInverted: config.logInverted || false,
    logToFile: config.logToFile || false,
    silent: !showInitMessages,
  });

  logger.debug(`[${processState.role.toUpperCase()}] Logger initialized.`);

  // Initialize database using DatabaseManager's method
  try {
    // Store directly in our exported db variable
    db = await initializeDatabase(config, logger);
    logger.debug(`[${processState.role.toUpperCase()}] Database initialized successfully`);
  } catch (err) {
    logger.error(`[${processState.role.toUpperCase()}] Fatal error initializing database: ${err}`);
    await handleMainShutdown("database initialization failure");
    return;
  }

  // Branch based on process type
  if (isShard()) {
    logger.info(
      `[${processState.role.toUpperCase()} ${processState.shardId}] Running via process ${process.pid}`
    );
    try {
      // Database is already initialized above
      logger.debug(
        `[${processState.role.toUpperCase()} ${processState.shardId}] About to call initBot`
      );
      await initBot(null, logger, config, db);
      logger.debug(
        `[${processState.role.toUpperCase()} ${processState.shardId}] Initialization completed successfully`
      );
      // Set the process as initialized
      processState.isInitialized = true;
    } catch (err) {
      logger.error(
        `[${processState.role.toUpperCase()} ${processState.shardId}] Failed to initialize: ${err instanceof Error ? err.message : String(err)}`
      );
      if (err instanceof Error && err.stack) logger.error(err.stack);
      // Clean up the lock file before exiting
      removeProcessLock(ProcessType.SHARD, processState.shardId);
      process.exit(1);
    }

    // Set up process-specific signal handlers for shards
    process.on("SIGINT", async () => {
      // Shards should wait for shutdown message from main
      logger.debug(
        `[${processState.role.toUpperCase()} ${processState.shardId}] Received SIGINT directly, waiting for main shutdown message`
      );
    });

    process.on("SIGTERM", async () => {
      // Shards should wait for shutdown message from main
      logger.debug(
        `[${processState.role.toUpperCase()} ${processState.shardId}] Received SIGTERM directly, waiting for main shutdown message`
      );
    });

    // Return early to prevent the rest of the main code from executing
    return;
  }

  // MAIN PROCESS CODE BELOW
  logger.info(
    `[${processState.role.toUpperCase()}] Initialization started via process ${process.pid}`
  );
  // Database is already initialized above

  // Main-specific command registration tasks.
  const args = process.argv.slice(2).filter((arg) => arg !== "--is-shard");
  // Load commands before checking for changes
  logger.debug(`[${processState.role.toUpperCase()}] Loading commands...`);
  try {
    await loadCommands();
    logger.debug(`[${processState.role.toUpperCase()}] Commands loaded.`);
  } catch (err) {
    logger.error(`[${processState.role.toUpperCase()}] Failed to load commands: ${err}`);
    await handleMainShutdown("command loading failure");
    return;
  }

  // Command registration and processing
  logger.debug(`[${processState.role.toUpperCase()}] Checking command registry parameters.`);
  const shouldRegisterCommands = await checkCommandChange();
  if (!shouldRegisterCommands) {
    logger.debug(
      `[${processState.role.toUpperCase()}] No command changes detected. Skipping registration.`
    );
  } else {
    try {
      logger.debug("Registering commands...");
      await registerCommands(!process.argv.includes("-local"), config);
      await genCommandHash(true);
      logger.debug("Command registration completed.");
    } catch (err) {
      logger.error(`Failed to register commands: ${err}`);
      await handleMainShutdown("command registration failure");
    }
  }

  if (process.argv.includes("-clear_commands")) {
    const local = process.argv.includes("-local");
    await clearCommands(local, config)
      .then(() => logger.done(`Removed all ${local ? "local" : "global"} commands.`))
      .catch((err) =>
        logger.error(`Failed to remove all ${local ? "local" : "global"} commands: ${err}`)
      );
  }

  if (process.argv.includes("-reg_commands")) {
    await registerCommands(!process.argv.includes("-local"), config)
      .then(() => logger.done("Commands registered successfully."))
      .catch(async (err) => {
        logger.error(`Failed to register commands: ${err}`);
        await handleMainShutdown("register commands failure");
      });
  }

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
  });

  process.on("uncaughtException", async (err) => {
    logger.error("[FATAL ERROR] encountered in the main process.");
    logger.error(err.toString());
    if (err.stack) logger.error(err.stack);
    await handleMainShutdown("uncaught exception");
  });

  logger.debug(`[${processState.role.toUpperCase()}] Creating ShardingManager.`);
  manager = new ShardingManager("./dist/index.js", {
    token: config.tokens.discord,
    // Pass environment flag as a command-line argument AND environment variable
    shardArgs: [...args, "--is-shard"],
    execArgv: process.execArgv,
    totalShards: "auto",
    respawn: true,
    mode: "process",
    silent: false,
  });
  logger.debug(`[${processState.role.toUpperCase()}] ShardingManager created.`);

  manager.on("shardCreate", (shard) => {
    shards.push(shard);
    logger.done(`Shard with id ${shard.id} spawned!`);
    // Set environment variable on the shard process
    shard.process?.send({ type: "SET_ENV", key: "SHARD_ID", value: shard.id });
    shard.on("error", (error) => logger.error(`Shard ${shard.id} encountered an error: ${error}`));
    shard.on("ready", () => {
      logger.debug(`Shard ${shard.id} is ready.`);
      webLog(`Shard ${shard.id} ready!`, null, Colors.Green);
    });
    shard.on("reconnecting", () => {
      if (!shuttingDown) {
        logger.debug(`Shard ${shard.id} is reconnecting.`);
        webLog(`Shard ${shard.id} is reconnecting!`, null, Colors.DarkGreen);
      }
    });
    shard.on("resume", () => {
      if (!shuttingDown) logger.debug(`Shard ${shard.id} resumed.`);
    });
    shard.on("death", () => {
      if (!shuttingDown) {
        logger.error(`Shard ${shard.id} died.`);
        webLog(`Shard ${shard.id} died!`, null, Colors.Red);
      } else {
        logger.debug(`Shard ${shard.id} died during shutdown.`);
      }
    });
    shard.on("disconnect", () => {
      if (!shuttingDown) {
        logger.debug(`Shard ${shard.id} disconnected`);
        webLog(`Shard ${shard.id} disconnected`, "Connection closed", Colors.Orange);
      }
    });
    shard.on("message", (message) => {
      if (message && message.op === "KILL_SHARD") {
        try {
          shard.kill();
          logger.done(`Successfully killed shard ${shard.id}.`);
        } catch (err) {
          logger.error(`Error killing shard ${shard.id}: ${err}`);
        }
      } else if (message && message.op === "RELOAD_COMMANDS") {
        // Handle the reload commands message
        reloadCommands()
          .then(() => {
            logger.done("Commands reloaded successfully on main process.");
            // Broadcast the reload command to all shards
            manager
              .broadcastEval(async (client) => {
                const { default: reloadCommands } = await import(
                  "./utilities/routines/reloadCommands"
                );
                await reloadCommands();
                return `Shard ${client.shard?.ids[0]} reloaded commands.`;
              })
              .then((results) => {
                logger.done(`Commands reloaded on all shards: ${results.join("\n")}`);
              })
              .catch((err) => {
                logger.error(`Failed to reload commands on all shards: ${err}`);
              });
          })
          .catch((err) => {
            logger.error(`Failed to reload commands on main process: ${err}`);
          });
      }
      logger.debug(`Shard ${shard.id} received message: ${message}`);
    });
  });

  // Handle shard disconnects using broadcastEval to listen to shard events
  manager.on("shardCreate", (shard) => {
    // Set up additional event listeners for the shard
    shard.on("disconnect", (CloseEvent?: { code?: number }) => {
      // Handle different disconnect codes properly
      let reason = "Unknown";

      // Get the code if available, otherwise default to 0
      const code: number = (CloseEvent?.code as number) || 0;
      switch (code) {
        case 1000:
          reason = "Normal closure";
          break;
        case 1001:
          reason = "Going away";
          break;
        case 1006:
          reason = "Abnormal closure";
          break;
        case 4004:
          reason = "Authentication failed";
          break;
        case 4010:
          reason = "Invalid shard";
          break;
        case 4011:
          reason = "Sharding required";
          break;
        case 4013:
          reason = "Invalid intents";
          break;
        case 4014:
          reason = "Disallowed intents";
          break;
        default:
          reason = `Code: ${code}`;
      }

      logger.warn(`Shard ${shard.id} disconnected: ${reason}`);
    });
  });

  logger.debug(
    `[${processState.role.toUpperCase()}] About to spawn shards with delay 7000ms and timeout 60000ms.`
  );

  try {
    await manager.spawn({
      delay: 7000, // Increased delay between shard spawns
      timeout: 60000, // Increased timeout for shard startup
    });
    logger.debug(`[${processState.role.toUpperCase()}] Shards spawned successfully.`);
    // Set the process as initialized
    processState.isInitialized = true;
  } catch (err) {
    if (err instanceof Response) {
      const errorText = await err.text();
      logger.error(`Failed to spawn shards: ${errorText}`);
    } else if (err instanceof Error) {
      logger.error(`Failed to spawn shards: ${err.message}`);
    } else {
      logger.error(`Failed to spawn shards: ${String(err)}`);
    }
    await handleMainShutdown("shard spawn failure");
  }

  // Start auxiliary services
  if (config.tokens.topgg) {
    logger.info("Using top.gg autoposter");
    AutoPoster(config.tokens.topgg, manager);
  }

  if (config.database.backupInterval) {
    scheduleBackups(db, logger);
  }

  if (config.statsServer.enabled) {
    start(manager, config.statsServer.port, db);
  }
};

// Only call initialize when this is the main module
if (require.main === module && !hasInitialized) {
  hasInitialized = true;
  trackInitState("Entry point execution");
  initialize().catch((err) => {
    trackInitState(`Initialization error: ${err instanceof Error ? err.message : String(err)}`);

    // Use console.error as fallback when logger isn't available
    if (logger && typeof logger.error === "function") {
      logger.error(`Initialization error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) logger.error(err.stack);
    } else {
      console.error(`Initialization error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
    }
  });

  // Set up main process signal handlers
  if (!isShard()) {
    process.on("SIGABRT", async () => {
      safeLog("debug", `[${processState.role.toUpperCase()}] Calling handleMainShutdown (SIGABRT)`);
      await handleMainShutdown("SIGABRT");
    });

    process.on("SIGINT", async () => {
      safeLog("debug", `[${processState.role.toUpperCase()}] Calling handleMainShutdown (SIGINT)`);
      await handleMainShutdown("SIGINT");
    });

    process.on("SIGTERM", async () => {
      safeLog("debug", `[${processState.role.toUpperCase()}] Calling handleMainShutdown (SIGTERM)`);
      await handleMainShutdown("SIGTERM");
    });
  }

  process.on("exit", () => {
    trackInitState(`Process ${process.pid} exit`);
    if (!isShard()) {
      safeLog("debug", `[${processState.role.toUpperCase()}] Process exit - cleaning up`);
      if (shuttingDown) {
        destroyShards();
      }
    } else {
      safeLog("debug", `[${processState.role.toUpperCase()} ${processState.shardId}] Process exit`);
    }
  });
}

export { logger, webLog };

// Export ShardManager accessor
export const getShardManager = () => manager;

// Add rate limit event handler
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.rest.on("rateLimited", (rateLimitInfo) => {
  rateLimitManager.handleRateLimit(rateLimitInfo);
});

// Add a request interceptor to check for rate limits before making requests
client.rest.on("request", (request) => {
  const route = request.route;
  if (rateLimitManager.isRateLimited(route)) {
    const resetTime = rateLimitManager.getRateLimitedUntil(route);
    const retryAfter = resetTime ? resetTime - Date.now() : 0;
    safeLog("warn", `Request to ${route} is rate limited. Retrying after ${retryAfter}ms`);
    return new Promise((resolve) => setTimeout(resolve, retryAfter)).then(() => request.make());
  }
  return request.make();
});
