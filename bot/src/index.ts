import {
  Client,
  Collection,
  ColorResolvable,
  Colors,
  EmbedBuilder,
  GatewayIntentBits,
  Shard,
  ShardingManager,
  WebhookClient,
} from "discord.js"
import { AutoPoster } from "topgg-autoposter"
import { initBot } from "./bot"
import { Database } from "./interfaces/database"
import { getConfig } from "./utilities/cnf/index"
import { initializeDatabase } from "./utilities/database/DatabaseManager"
import { logMemoryUsage, trackInitState } from "./utilities/debugUtils"
import { ErrorSeverity, handleApiError } from "./utilities/errorSystem"
import loadCommands from "./utilities/loadCommands"
import { initLogger, Log76, logToFile } from "./utilities/logger"
import { getShardId, isShard, ProcessRole, processState } from "./utilities/processState"
import { rateLimitManager } from "./utilities/rateLimitManager"
import {
  checkCommandChange,
  clearCommands,
  genCommandHash,
  registerCommands,
} from "./utilities/registerCommands"
import scheduleBackups from "./utilities/routines/backup"
import reloadCommands from "./utilities/routines/reloadCommands"
import {
  createShutdownManager,
  exitProcess,
  ShutdownManager,
  ShutdownPriority,
} from "./utilities/shutdown"
import {
  acquireInitLock,
  cleanupStaleLocks,
  createMainProcessLock,
  createShardProcessLock,
  ProcessType,
  removeProcessLock,
} from "./utilities/startup"
import start from "./web"

// Global variables
const isShardProcess = isShard();
const showInitMessages = Boolean(process.env.INIT_DEBUG);
const configData = getConfig();
let manager: ShardingManager;
let shuttingDown = false;
const shards: Shard[] = [];
let shardsDestroyed = false;
let hasInitialized = false;
// skipcq: JS-E1009
export let db: Database;
// skipcq: JS-E1009
export let shutdownManager: ShutdownManager;
// skipcq: JS-E1009
export let logger: Log76;

// Add diagnostic logging if enabled
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

/**
 * Safe logging function that works before logger initialization
 */
const safeLog = (level: string, message: string): void => {
  if (logger && typeof logger[level as keyof typeof logger] === "function") {
    try {
      const logFn = logger[level as keyof typeof logger] as unknown as (msg: string) => void;
      logFn(message);
      return;
    } catch {
      // Fall back to console if logger method fails
    }
  }

  const timestamp = new Date().toISOString();
  if (level === "error") {
    console.error(`${timestamp} [ERROR] ${message}`);
  } else if (level === "warn") {
    console.warn(`${timestamp} [WARN] ${message}`);
  } else {
    console.log(`${timestamp} [${level.toUpperCase()}] ${message}`);
  }
};

/**
 * Initialize Discord REST client
 */
const initDiscordClient = (): Client => {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  // Setup rate limit handlers
  client.rest.on("rateLimited", (rateLimitInfo) => {
    rateLimitManager.handleRateLimit(rateLimitInfo);
  });

  client.rest.on("request", async (request) => {
    const route = request.route;
    if (rateLimitManager.isRateLimited(route)) {
      const resetTime = rateLimitManager.getRateLimitedUntil(route);
      const retryAfter = resetTime ? resetTime - Date.now() : 0;
      safeLog("warn", `Request to ${route} is rate limited. Retrying after ${retryAfter}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfter));
      return request.make();
    }
    return request.make();
  });

  return client;
};

/**
 * Handle shards destruction during shutdown
 */
const destroyShards = (): void => {
  if (shardsDestroyed) return;
  shardsDestroyed = true;

  for (const shard of shards) {
    if (shard.process && !shard.process.killed) {
      try {
        shard.kill();
        safeLog("debug", `Killed shard ${shard.id}`);
      } catch (err) {
        safeLog("error", `Failed to kill shard ${shard.id}: ${String(err)}`);
      }
    }
  }
};

/**
 * Log to webhook if configured
 */
const webLog = async (
  title: string,
  description: string | null,
  colour: ColorResolvable = Colors.Aqua
): Promise<void> => {
  if (!configData.logWebhook) return;

  try {
    const webhookClient = new WebhookClient({ url: configData.logWebhook });
    const embed = new EmbedBuilder().setTitle(title).setTimestamp(new Date()).setColor(colour);

    if (description) embed.setDescription(description);

    const logMessage = `${title}: ${description || ""}`;
    await logToFile(logMessage);

    await webhookClient.send({
      username: "Thread-Watcher",
      avatarURL: "https://threadwatcher.xyz/content/icon.png",
      embeds: [embed],
    });
  } catch (error) {
    safeLog(
      "error",
      `Failed to send webhook: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Main shutdown handler for master process
 */
const handleMainShutdown = async (reason: string): Promise<void> => {
  if (shuttingDown) {
    safeLog(
      "debug",
      `Shutdown already in progress, ignoring duplicate shutdown trigger: ${reason}`
    );
    return;
  }

  safeLog("info", `[${processState.role.toUpperCase()}] Shutdown initiated due to: ${reason}`);
  trackInitState(`Main process shutdown started: ${reason}`);
  shuttingDown = true;

  // Notify all shards to shut down
  if (manager) {
    safeLog(
      "debug",
      `[${processState.role.toUpperCase()}] Sending shutdown signal to ${manager.shards.size} shards`
    );

    const shutdownPromises = [];
    for (const shard of manager.shards.values()) {
      if (shard.process && !shard.process.killed) {
        shutdownPromises.push(
          shard
            .send("shutdown")
            .catch((err) =>
              safeLog(
                "error",
                `Failed to send shutdown signal to shard ${shard.id}: ${String(err)}`
              )
            )
        );
      }
    }

    await Promise.allSettled(shutdownPromises);

    // Give shards more time to process their shutdown sequence before proceeding
    safeLog(
      "debug",
      `[${processState.role.toUpperCase()}] Waiting for shards to shut down (8s timeout)`
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 8000));
  }

  // Use shutdown manager for cleanup if available
  if (shutdownManager) {
    try {
      await shutdownManager.shutdown(0, reason);
      return;
    } catch (err) {
      safeLog("error", `Error during shutdown manager execution: ${String(err)}`);
      if (db && typeof db.close === "function") {
        try {
          await db.close();
          safeLog("info", "Database closed manually during fallback cleanup");
        } catch (dbErr) {
          safeLog("error", `Failed to close database during fallback: ${String(dbErr)}`);
        }
      }
    }
  } else {
    // Manual cleanup if shutdown manager isn't available
    if (db && typeof db.close === "function") {
      try {
        await db.close();
      } catch (err) {
        safeLog("error", `Error closing database: ${String(err)}`);
      }
    }
  }

  // Remove the process lock file
  removeProcessLock(ProcessType.MAIN);

  safeLog("done", `[${processState.role.toUpperCase()}] Shutdown complete. Exiting process.`);
  trackInitState("Main process exit");

  // Use exitProcess instead of direct process.exit
  exitProcess(0, `Completed shutdown: ${reason}`);
};

/**
 * Set up process and environment for initialization
 */
function setupEnvironment(): boolean {
  // Prevent multiple initializations
  if (!acquireInitLock()) {
    safeLog("warn", `Process ${process.pid} tried to initialize again, ignoring.`);
    return false;
  }

  if (isShard()) {
    processState.role = ProcessRole.SHARD;
    processState.shardId = getShardId();
    process.env.IS_SHARD = "true";

    if (!createShardProcessLock(processState.shardId)) {
      safeLog("error", "Failed to create shard lock file. Process may be unstable.");
    }

    trackInitState(`Shard ${processState.shardId} process starting`);
  } else {
    processState.role = ProcessRole.MAIN;

    cleanupStaleLocks();

    if (!createMainProcessLock()) {
      safeLog("error", "Another main process is already running. Exiting.");
      exitProcess(1, "Another main process is already running");
      return false;
    }

    trackInitState("Main process starting");

    if (showInitMessages) {
      safeLog("debug", `Main process successfully acquired lock with PID ${process.pid}`);
      logMemoryUsage();
    }
  }
  return true;
}

/**
 * Set up core services needed by both main and shard processes
 */
function setupCoreServices(): Promise<void> {
  const loggerInstance = initLogger({
    logLevel: configData.logLevel,
    logBold: configData.logBold || false,
    logInverted: configData.logInverted || false,
    logToFile: configData.logToFile || false,
    silent: !showInitMessages,
  }) as Log76;

  logger = loggerInstance;
  logger.debug(`[${processState.role.toUpperCase()}] Logger initialized.`);

  // Initialize Discord client for rate limit handling
  const discordClient = initDiscordClient();

  shutdownManager = createShutdownManager(discordClient);

  // Register cleanup tasks
  shutdownManager.registerCleanupTask(
    async () => {
      if (db && typeof db.close === "function") {
        try {
          await db.close();
          logger.info("Database connections closed");
        } catch (err) {
          logger.error(`Failed to close database: ${String(err)}`);
        }
      }
    },
    {
      name: "Database Cleanup",
      priority: ShutdownPriority.HIGH,
      timeout: 10000,
    }
  );

  db = initializeDatabase(configData, logger);
  logger.debug(`[${processState.role.toUpperCase()}] Database initialized successfully`);

  return Promise.resolve();
}

/**
 * Initialize shard-specific functionality
 */
async function initializeShardProcess(): Promise<void> {
  logger.debug(
    `[${processState.role.toUpperCase()} ${processState.shardId}] Running via process ${process.pid}`
  );
  await initBot(null, logger, configData, db, shutdownManager);
  logger.debug(
    `[${processState.role.toUpperCase()} ${processState.shardId}] Initialization completed successfully`
  );
  processState.isInitialized = true;

  // Set up signal handlers for shards - these should only log, not trigger shutdown
  process.on("SIGINT", () => {
    logger.debug(
      `[${processState.role.toUpperCase()} ${processState.shardId}] Received SIGINT directly, waiting for main shutdown message`
    );
    // DO NOT call shutdown here - parent process will coordinate
  });

  process.on("SIGTERM", () => {
    logger.debug(
      `[${processState.role.toUpperCase()} ${processState.shardId}] Received SIGTERM directly, waiting for main shutdown message`
    );
    // DO NOT call shutdown here - parent process will coordinate
  });

  // Register a message handler for shutdown commands
  process.on("message", (message) => {
    if (message === "shutdown") {
      logger.info(
        `[${processState.role.toUpperCase()} ${processState.shardId}] Received shutdown command, shutting down`
      );

      if (shutdownManager) {
        shutdownManager.shutdown(0, "Received shutdown command from main process");
      } else {
        exitProcess(0, "Received shutdown command from main process");
      }
    }
  });
}

/**
 * Handle Discord command setup and registration
 */
async function setupCommands(): Promise<void> {
  logger.debug(`[${processState.role.toUpperCase()}] Loading commands...`);
  await loadCommands();
  logger.debug(`[${processState.role.toUpperCase()}] Commands loaded.`);

  // Command registration and processing
  logger.debug(`[${processState.role.toUpperCase()}] Checking command registry parameters.`);
  const shouldRegisterCommands = await checkCommandChange();

  if (shouldRegisterCommands) {
    logger.debug("Registering commands...");
    await registerCommands(!process.argv.includes("-local"), configData);
    await genCommandHash(true);
    logger.debug("Command registration completed.");
  } else {
    logger.debug(
      `[${processState.role.toUpperCase()}] No command changes detected. Skipping registration.`
    );
  }

  await handleSpecialCommandLineArgs();
}

/**
 * Process special command line arguments
 */
async function handleSpecialCommandLineArgs(): Promise<void> {
  if (process.argv.includes("-clear_commands")) {
    const local = process.argv.includes("-local");
    try {
      await clearCommands(local, configData);
      logger.done(`Removed all ${local ? "local" : "global"} commands.`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to remove all ${local ? "local" : "global"} commands: ${errorMessage}`);
    }
  }

  if (process.argv.includes("-reg_commands")) {
    await registerCommands(!process.argv.includes("-local"), configData);
    logger.done("Commands registered successfully.");
  }
}

/**
 * Configure error handlers for the main process
 */
function setupMainProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const reasonStr = reason instanceof Error ? reason.message : String(reason);
    logger.error(`Unhandled Rejection: ${reasonStr}`);
    if (reason instanceof Error && reason.stack) {
      logger.error(`Stack trace: ${reason.stack}`);
    }
  });

  process.on("uncaughtException", async (err) => {
    logger.error("[FATAL ERROR] encountered in the main process.");
    logger.error(err instanceof Error ? err.message : String(err));
    if (err.stack) logger.error(err.stack);
    await handleMainShutdown("uncaught exception");
  });
}

/**
 * Handle shard message processing
 */
function handleShardMessage(shard: Shard, message: unknown): void {
  try {
    if (
      Array.isArray(message) &&
      message.length > 0 &&
      typeof message[0] === "object" &&
      "id" in message[0]
    ) {
      const messageCollection = new Collection(message.map((item) => [item.id as string, item]));

      const threadMessages = messageCollection.filter((msg) => msg.type === "thread");
      if (threadMessages.size > 0) {
        logger.debug(
          `Received ${threadMessages.size} thread-related messages from shard ${shard.id}`
        );
      }
    } else if (message && typeof message === "object") {
      const messageObj = message as Record<string, unknown>;

      // Check for Discord.js internal ready message
      if ("_ready" in messageObj && messageObj._ready === true) {
        const shardId = messageObj.id !== undefined ? messageObj.id : shard.id;
        logger.info(`Discord.js marked shard ${shardId} as ready`);
      }
      // Special handling for our custom SHARD_READY message
      else if (messageObj.type === "SHARD_READY") {
        const shardId = messageObj.id !== undefined ? messageObj.id : shard.id;
        logger.info(`Received SHARD_READY confirmation from shard ${shardId}`);
      } else if (messageObj.op === "KILL_SHARD") {
        try {
          shard.kill();
          logger.done(`Successfully killed shard ${shard.id}.`);
        } catch (err) {
          logger.error(`Error killing shard ${shard.id}: ${String(err)}`);
        }
      } else if (messageObj.op === "RELOAD_COMMANDS") {
        handleReloadCommands();
      }

      try {
        logger.debug(`Shard ${shard.id} received message: ${JSON.stringify(message)}`);
      } catch {
        logger.debug(
          `Shard ${shard.id} received message that couldn't be stringified: ${typeof message}`
        );
      }
    } else if (typeof message === "string") {
      logger.debug(`Shard ${shard.id} received message: ${message}`);
    } else {
      logger.debug(`Shard ${shard.id} received message of type: ${typeof message}`);
    }
  } catch (error) {
    logger.error(`Error handling message from shard ${shard.id}: ${String(error)}`);
  }
}

/**
 * Handle the RELOAD_COMMANDS operation
 */
function handleReloadCommands(): void {
  reloadCommands()
    .then(() => {
      logger.done("Commands reloaded successfully on main process.");
      // Broadcast the reload command to all shards
      if (manager) {
        manager
          .broadcastEval(async (client) => {
            const { default: reloadCommands } = await import("./utilities/routines/reloadCommands");
            await reloadCommands();
            return `Shard ${client.shard?.ids[0]} reloaded commands.`;
          })
          .then((results) => {
            logger.done(`Commands reloaded on all shards: ${results.join("\n")}`);
          })
          .catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to reload commands on all shards: ${errorMessage}`);
          });
      }
    })
    .catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to reload commands on main process: ${errorMessage}`);
    });
}

/**
 * Configure a shard with event handlers
 */
function setupShardEventHandlers(shard: Shard): void {
  shards.push(shard);
  logger.done(`Shard ${shard.id} spawned!`);

  if (shard.process?.send) {
    try {
      shard.process.send({ type: "SET_ENV", key: "SHARD_ID", value: shard.id.toString() });
    } catch (err) {
      logger.error(`Failed to send SHARD_ID to shard ${shard.id}: ${String(err)}`);
    }
  }

  // Set up shard event handlers
  shard.on("error", (error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Shard ${shard.id} encountered an error: ${errorMessage}`);
  });

  shard.on("ready", () => {
    logger.trace(`Shard ${shard.id} is ready.`);
    webLog(`Shard ${shard.id} ready!`, null, Colors.Green).catch((err) =>
      logger.error(`Failed to send webhook for shard ${shard.id} ready: ${String(err)}`)
    );
  });

  shard.on("reconnecting", () => {
    if (!shuttingDown) {
      logger.debug(`Shard ${shard.id} is reconnecting.`);
      webLog(`Shard ${shard.id} is reconnecting!`, null, Colors.DarkGreen).catch(() => {
        // Silent fail for webhook during reconnection is appropriate
      });
    }
  });

  shard.on("resume", () => {
    if (!shuttingDown) logger.debug(`Shard ${shard.id} resumed.`);
  });

  shard.on("death", () => {
    if (!shuttingDown) {
      logger.error(`Shard ${shard.id} died.`);
      webLog(`Shard ${shard.id} died!`, null, Colors.Red).catch(() => {
        // Silent fail for webhook during death is appropriate
      });
    } else {
      logger.debug(`Shard ${shard.id} died during shutdown.`);
    }
  });

  shard.on("disconnect", () => {
    if (!shuttingDown) {
      logger.debug(`Shard ${shard.id} disconnected`);
      webLog(`Shard ${shard.id} disconnected`, "Connection closed", Colors.Orange).catch(() => {
        // Silent fail for webhook during disconnect is appropriate
      });
    }
  });

  shard.on("message", (message) => handleShardMessage(shard, message));
}

/**
 * Create and configure the sharding manager
 */
function setupShardingManager(args: string[]): ShardingManager {
  logger.debug(`[${processState.role.toUpperCase()}] Creating ShardingManager.`);

  // Get shard count from config or use "auto" as fallback
  const shardCount = configData.shardCount !== undefined ? configData.shardCount : 1;

  logger.debug(`Configuring ShardingManager with totalShards: ${shardCount}`);

  const newManager = new ShardingManager("./dist/index.js", {
    token: configData.tokens.discord,
    shardArgs: [...args, "--is-shard"],
    execArgv: process.execArgv,
    totalShards: shardCount,
    respawn: true,
    mode: "process",
    silent: false,
  });

  logger.debug(`[${processState.role.toUpperCase()}] ShardingManager created.`);

  // Set up shard creation handler
  newManager.on("shardCreate", (shard) => setupShardEventHandlers(shard));

  return newManager;
}

/**
 * Spawn shards with error handling and state tracking
 */
let shardSpawningInProgress = false;
let spawnTimeoutId: NodeJS.Timeout | null = null;

async function spawnShards(manager: ShardingManager): Promise<void> {
  if (shardSpawningInProgress) {
    logger.warn("Shard spawning already in progress, skipping duplicate request");
    return;
  }

  shardSpawningInProgress = true;

  try {
    // If shards are already active, consider this a success and return early
    if (manager.shards.size > 0) {
      logger.info(`${manager.shards.size} shards already active, skipping spawn`);
      shardSpawningInProgress = false;
      return;
    }

    try {
      const spawnTimeout = 180000;
      logger.debug(`Starting shard spawn process with timeout of ${spawnTimeout / 1000} seconds`);

      // Set our own timeout as a safety measure
      if (spawnTimeoutId) clearTimeout(spawnTimeoutId);

      // Create a safety timeout that won't crash the process if exceeded
      spawnTimeoutId = setTimeout(() => {
        logger.warn(
          `Shard spawn safety timeout (${spawnTimeout / 1000}s) triggered, but continuing anyway`
        );

        // Check if any shards are active and proceed if possible
        if (manager.shards.size > 0) {
          logger.info(`Found ${manager.shards.size} active shards despite timeout`);

          // Try to verify responsiveness
          manager
            .broadcastEval(() => "ready")
            .then((results) => {
              logger.info(`Verified ${results.length} responsive shards despite timeout`);
            })
            .catch((err) => {
              logger.warn(`Failed to verify shard responsiveness: ${err}`);
            });
        }
      }, spawnTimeout + 10000); // Add 10s buffer to our safety timeout

      const spawnOptions = {
        timeout: spawnTimeout,
        ...(manager.shardList.length > 0 ? { shardList: manager.shardList } : {}),
      };

      // Get actual shard count to be spawned
      const shardCountToSpawn =
        Array.isArray(manager.shardList) && manager.shardList.length > 0
          ? manager.shardList.length
          : typeof manager.totalShards === "number"
            ? manager.totalShards
            : "auto";

      logger.debug(`Spawning ${shardCountToSpawn} shard(s)...`);

      await manager.spawn(spawnOptions);

      // Clear our safety timeout if spawn succeeds
      if (spawnTimeoutId) {
        clearTimeout(spawnTimeoutId);
        spawnTimeoutId = null;
      }

      logger.debug(`Successfully spawned ${manager.shards.size} shards`);
    } catch (spawnError) {
      // Clear our safety timeout if spawn fails
      if (spawnTimeoutId) {
        clearTimeout(spawnTimeoutId);
        spawnTimeoutId = null;
      }

      const errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);

      if (errorMessage.includes("took too long to become ready") && manager.shards.size > 0) {
        logger.warn(
          `Shard readiness timeout, but ${manager.shards.size} shard(s) are active. Proceeding normally.`
        );

        // Verify shard responsiveness despite timeout
        try {
          const pingResult = await manager.broadcastEval(() => "ready");
          logger.info(`Verified ${pingResult.length} responsive shards despite timeout`);

          // This is considered a success, so just return instead of throwing
          shardSpawningInProgress = false;
          return;
        } catch (evalError) {
          logger.warn(`Shard responsiveness check after timeout: ${evalError}`);
          // Continue to error handling if eval fails
        }
      }

      if (errorMessage.includes("Already spawned") && manager.shards.size > 0) {
        logger.info(`Using ${manager.shards.size} existing shards (${errorMessage})`);
        shardSpawningInProgress = false;
        return;
      }

      // Re-throw for all other errors
      throw spawnError;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to spawn shards: ${errorMessage}`);

    // Only throw if we couldn't actually spawn any shards
    if (manager.shards.size === 0) {
      throw error;
    } else {
      logger.warn(`Proceeding with ${manager.shards.size} active shards despite spawn errors`);
    }
  } finally {
    // Always clear the safety timeout and reset the flag
    if (spawnTimeoutId) {
      clearTimeout(spawnTimeoutId);
      spawnTimeoutId = null;
    }
    shardSpawningInProgress = false;
  }
}

/**
 * Initialize auxiliary services (top.gg, backups, stats)
 */
async function initializeAuxiliaryServices(): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (configData.tokens.topgg) {
    tasks.push(initializeTopGG());
  }

  if (configData.database.backupInterval) {
    tasks.push(initializeBackups());
  }

  if (configData.statsServer.enabled) {
    tasks.push(initializeStatsServer());
  }

  await Promise.allSettled(tasks);
}

/**
 * Initialize Top.gg autoposter
 */
function initializeTopGG(): Promise<void> {
  return handleApiError(
    "Failed to initialize Top.gg autoposter",
    () => {
      logger.info("Using top.gg autoposter");
      AutoPoster(configData.tokens.topgg, manager);
      logger.debug("Top.gg autoposter initialized successfully");

      return Promise.resolve();
    },
    {
      retries: 2,
      retryDelay: 1000,
      context: "Top.gg Integration",
      reportAtSeverity: ErrorSeverity.MEDIUM,
    }
  );
}

/**
 * Initialize database backup system
 */
function initializeBackups(): Promise<void> {
  return handleApiError(
    "Failed to schedule database backups",
    () => {
      scheduleBackups(db, logger);
      logger.debug("Database backups scheduled successfully");

      return Promise.resolve();
    },
    {
      retries: 1,
      retryDelay: 500,
      context: "Backup Scheduling",
      reportAtSeverity: ErrorSeverity.MEDIUM,
    }
  );
}

/**
 * Initialize stats server
 */
function initializeStatsServer(): Promise<void> {
  return handleApiError(
    "Failed to start stats server",
    () => {
      start(manager, configData.statsServer.port, db);
      logger.info(`Stats server started on port ${configData.statsServer.port}`);

      return Promise.resolve();
    },
    {
      retries: 3,
      retryDelay: 1000,
      context: "Stats Server Startup",
      reportAtSeverity: ErrorSeverity.HIGH,
    }
  );
}

/**
 * Initialize the main process with shard handling
 */
async function initializeMainProcess(): Promise<void> {
  logger.debug(
    `[${processState.role.toUpperCase()}] Initialization started via process ${process.pid}`
  );

  // Command handling for main process
  const args = process.argv.slice(2).filter((arg) => arg !== "--is-shard");
  await setupCommands();

  setupMainProcessErrorHandlers();

  manager = setupShardingManager(args);

  try {
    await spawnShards(manager);

    if (manager.shards.size > 0) {
      await initializeAuxiliaryServices();
      logger.done(`Thread-Watcher initialized with ${manager.shards.size} active shards`);
    } else {
      logger.error("No shards were spawned successfully, cannot proceed with initialization");
      throw new Error("No shards spawned");
    }
  } catch (error) {
    logger.error(`Failed to initialize sharding: ${error}`);
    throw error;
  }
}

/**
 * Initialize function handling both shard and main processes
 */
export const initialize = async (): Promise<void> => {
  try {
    if (!setupEnvironment()) {
      return;
    }

    await setupCoreServices();

    if (isShard()) {
      await initializeShardProcess();
    } else {
      await initializeMainProcess();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (logger) {
      logger.error(`Initialization error: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        logger.error(`Stack trace: ${err.stack}`);
      }
    } else {
      console.error(`Initialization error: ${errorMessage}`);
    }

    if (!isShardProcess) {
      await handleMainShutdown("initialization failure");
    } else {
      exitProcess(1, "Shard initialization failed");
    }
  }
};

// Entry point - only run initialize when this is the main module
if (require.main === module && !hasInitialized) {
  hasInitialized = true;
  trackInitState("Entry point execution");
  initialize().catch((err) => {
    trackInitState(`Initialization error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Initialization error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);

    exitProcess(1, `Initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Set up process signal handlers - only register what's needed based on process role
  if (!isShard()) {
    // Main process already has signal handlers from shutdownManager
    // Just add the exit handler for cleanup
    process.on("exit", (code) => {
      trackInitState(`Process ${process.pid} exit with code ${code}`);
      safeLog(
        "debug",
        `[${processState.role.toUpperCase()}] Process exit with code ${code} - cleaning up`
      );
      if (shuttingDown) {
        destroyShards();
      }
    });
  } else {
    // For shard processes, only log the signals but let parent manage shutdown
    // No need for duplicate handlers here, as initializeShardProcess already sets them up
    process.on("exit", (code) => {
      trackInitState(`Process ${process.pid} exit with code ${code}`);
      safeLog(
        "debug",
        `[${processState.role.toUpperCase()} ${processState.shardId}] Process exit with code ${code}`
      );
    });
  }
}

// Export necessary objects and functions
export { configData as config, webLog }

// Accessor for ShardManager
export const getShardManager = (): ShardingManager | undefined => manager;
