import {
  Client,
  Collection,
  ColorResolvable,
  Colors,
  EmbedBuilder,
  GatewayIntentBits,
  RateLimitData,
  Shard,
  ShardingManager,
  WebhookClient,
} from "discord.js";
import { AutoPoster } from "topgg-autoposter";
import { initBot } from "./bot";
import { Database } from "./interfaces/database";
import { SERVICE_KEYS, serviceRegistry } from "./services";
import { getConfig } from "./utilities/cnf";
import { initializeDatabase } from "./utilities/database/DatabaseManager";
import { logMemoryUsage, trackInitState } from "./utilities/debugUtils";
import { ErrorSeverity, handleApiError } from "./utilities/errorSystem";
import loadCommands from "./utilities/loadCommands";
import { initLogger, logToFile, safeLog } from "./utilities/logger";
import {
  getShardId,
  isMainProcess,
  isShard,
  ProcessRole,
  processState,
} from "./utilities/processState";
import { rateLimitManager } from "./utilities/rateLimitManager";
import {
  checkCommandChange,
  clearCommands,
  genCommandHash,
  registerCommands,
} from "./utilities/registerCommands";
import scheduleBackups from "./utilities/routines/backup";
import reloadCommands from "./utilities/routines/reloadCommands";
import {
  createShutdownManager,
  exitProcess,
  initializeShutdownHandlers,
  ShutdownPriority,
} from "./utilities/shutdown";
import {
  acquireInitLock,
  cleanupStaleLocks,
  createMainProcessLock,
  createShardProcessLock,
  ProcessType,
  removeProcessLock,
} from "./utilities/startup";
import { threadManager } from "./utilities/threadManager";
import start from "./web";

// Load config file immediately
const _configData = getConfig();

// Track initialization state consistently across the app
let _applicationStartupComplete = false;
let _messagesSuppressed = false;

// Initialize logger as early as possible
export const logger = initLogger({
  logLevel: _configData.logLevel,
  logBold: _configData.logBold || false,
  logInverted: _configData.logInverted || false,
  logToFile: _configData.logToFile || false,
  silent: false, // Never silence logger during startup
});

// Register core services right away
serviceRegistry.register(SERVICE_KEYS.LOGGER, logger);
serviceRegistry.register(SERVICE_KEYS.CONFIG, _configData);

// Global variables with proper underscore prefix for private vars
const _isShardProcess = isShard();
let _shardManager: ShardingManager;
let _localShutdownManager: ReturnType<typeof createShutdownManager>;
let _shuttingDown = false;
const _shards: Shard[] = [];
let _shardsDestroyed = false;
let _hasInitialized = false;
let _isStartupInProgress = false;
let _spawnTimeoutId: NodeJS.Timeout | null = null;
let _shardSpawningInProgress = false;

// Global shutdown flag
declare global {
  // eslint-disable-next-line no-var
  var isShuttingDown: boolean;
}
global.isShuttingDown = false;

// Only show the Thread-Watcher startup message once in the main process
if (!_isShardProcess) {
  if (logger) {
    logger.info("Starting Thread-Watcher application...");
  } else {
    console.log("Starting Thread-Watcher application...");
  }
}

// Module-level tracking flags to prevent duplicate initializations
let _shutdownManagerInitialized = false;
let _taskRegistrationComplete = false;

// Timeouts collection for proper cleanup
const _initTimeouts = new Set<NodeJS.Timeout>();

const _shardTimeoutMap = new Collection<string, NodeJS.Timeout>();

/**
 * Initialize Discord REST client
 */
let _discordClient: Client | null = null;

const initDiscordClient = (): Client => {
  if (_discordClient) {
    return _discordClient;
  }

  _discordClient = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  // Setup rate limit handlers
  _discordClient.rest.on("rateLimited", (rateLimitInfo) => {
    rateLimitManager.handleRateLimit(rateLimitInfo);
  });

  _discordClient.rest.on("request", async (request) => {
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

  // Register client in service registry
  serviceRegistry.register(SERVICE_KEYS.CLIENT, _discordClient);

  return _discordClient;
};

/**
 * Safe getter for local shutdown manager to avoid circular dependencies
 * Ensures a shutdown manager is always available even during initialization
 */
export function getShutdownManager(): ReturnType<typeof createShutdownManager> {
  // First check our local instance which is guaranteed to exist
  if (_localShutdownManager) {
    return _localShutdownManager;
  }

  // Next try the service registry, but handle errors safely
  try {
    // Only try the registry if we know it won't throw an error
    if (serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
      return serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER);
    }
  } catch {
    // Silent catch - just fall through to create a new manager
  }

  // If all else fails, create a new temporary manager
  // This ensures we always return something usable
  if (!_localShutdownManager) {
    logger.debug("Creating emergency shutdown manager instance");
    const tempClient = new Client({ intents: [] }); // Minimal client for the manager
    _localShutdownManager = createShutdownManager(tempClient);

    // Register the shutdown manager in the service registry
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
      serviceRegistry.register(SERVICE_KEYS.SHUTDOWN_MANAGER, _localShutdownManager);

      _shutdownManagerInitialized = true;
    }
  }

  return _localShutdownManager;
}

/**
 * Handle shards destruction during shutdown
 */
const destroyShards = (): void => {
  if (_shardsDestroyed) return;
  _shardsDestroyed = true;

  for (const shard of _shards) {
    if (shard.process && !shard.process.killed) {
      try {
        shard.kill();
        safeLog("debug", `Killed shard ${shard.id}`, "SHUTDOWN");
      } catch (err) {
        safeLog("error", `Failed to kill shard ${shard.id}: ${String(err)}`, "SHUTDOWN");
      }
    }
  }
};

/**
 * Log to webhook if configured
 * @param title - Message title
 * @param description - Message description
 * @param color - Message color
 * @returns Promise that resolves when the webhook message is sent
 */
export async function webLog(
  title: string,
  description: string | null,
  color: ColorResolvable = Colors.Aqua
): Promise<void> {
  if (!_configData.logWebhook) return;

  // Validate the webhook URL
  try {
    new URL(_configData.logWebhook);
  } catch {
    safeLog("error", "Invalid webhook URL provided in _configData.logWebhook", "WEBHOOK");
    return;
  }

  try {
    const webhookClient = new WebhookClient({ url: _configData.logWebhook });
    const embed = new EmbedBuilder().setTitle(title).setTimestamp(new Date()).setColor(color);

    if (description) embed.setDescription(description);

    const logMessage = `${title}: ${description || ""}`;
    void logToFile(logMessage);

    await webhookClient.send({
      username: "Thread-Watcher",
      avatarURL: "https://threadwatcher.xyz/content/icon.png",
      embeds: [embed],
    });
  } catch (error) {
    safeLog(
      "error",
      `Failed to send webhook: ${error instanceof Error ? error.message : String(error)}`,
      "WEBHOOK"
    );
  }
}

// Define default timeout values directly
const DEFAULT_TIMEOUTS = {
  SHUTDOWN_FORCE_EXIT: 15000, // 15 seconds before force exit
  SHARD_SHUTDOWN_GRACE: 3000, // 3 seconds grace period for shards
  SHARD_SHUTDOWN_MAX_WAIT: 5000, // 5 seconds max wait for shards
  SHARD_SPAWN_TIMEOUT: 180000, // 3 minutes for shard spawn
  SHARD_SAFETY_TIMEOUT: 10000, // 10 seconds safety timeout
};

/**
 * Main shutdown handler for master process
 */
const handleMainShutdown = async (reason: string): Promise<void> => {
  global.isShuttingDown = true;

  // Prevent duplicate shutdown attempts
  if (_shuttingDown) {
    safeLog(
      "debug",
      `Shutdown already in progress, ignoring duplicate shutdown trigger: ${reason}`
    );
    return;
  }

  safeLog("info", `Shutdown initiated due to: ${reason}`, "SHUTDOWN");
  trackInitState(`Main process shutdown started: ${reason}`);
  _shuttingDown = true;

  // Get timeout values directly from defaults
  const forceExitTimeout = DEFAULT_TIMEOUTS.SHUTDOWN_FORCE_EXIT;

  // Set a single force exit timeout
  const forceExitTimeoutId = setTimeout(() => {
    safeLog("error", `Shutdown taking too long (${forceExitTimeout}ms) - forcing exit`);
    process.exit(1);
  }, forceExitTimeout);

  try {
    // Notify all shards to shut down
    const shardManager = getShardManager();
    if (shardManager && shardManager.shards.size > 0) {
      safeLog("debug", `Sending shutdown signal to ${shardManager.shards.size} shards`);

      // First wait for all shards to get the signal
      const shutdownPromises = [];
      for (const shard of shardManager.shards.values()) {
        if (shard.process && !shard.process.killed) {
          shutdownPromises.push(
            shard
              .send("shutdown")
              .catch((err) =>
                safeLog(
                  "error",
                  `Failed to send shutdown signal to shard ${shard.id}: ${String(err)}`,
                  "SHUTDOWN"
                )
              )
          );
        }
      }

      // Wait for all shutdown messages to be sent
      await Promise.allSettled(shutdownPromises);

      // Get grace period directly from defaults
      const shardGracePeriod = DEFAULT_TIMEOUTS.SHARD_SHUTDOWN_GRACE;

      // Give shards time to begin their shutdown sequence
      safeLog(
        "debug",
        `Waiting for shards to acknowledge shutdown (${shardGracePeriod}ms grace period)`,
        "SHUTDOWN"
      );
      await new Promise<void>((resolve) => setTimeout(resolve, shardGracePeriod));

      // Now wait for shards to process their shutdown sequence
      try {
        // Get timeout value directly from defaults
        const maxWaitTime = DEFAULT_TIMEOUTS.SHARD_SHUTDOWN_MAX_WAIT;

        safeLog("debug", `Waiting up to ${maxWaitTime}ms for shards to terminate`, "SHUTDOWN");

        // Set a timeout to force kill any remaining shards
        const killTimeout = setTimeout(() => {
          safeLog("warn", "Shard shutdown timeout exceeded, forcing termination", "SHUTDOWN");
          destroyShards();
        }, maxWaitTime);

        // Check for up to maxWaitTime if shards are terminated
        const endTime = Date.now() + maxWaitTime;
        while (Date.now() < endTime) {
          let allShardsTerminated = true;

          for (const shard of shardManager.shards.values()) {
            if (shard.process && !shard.process.killed) {
              allShardsTerminated = false;
              break;
            }
          }

          if (allShardsTerminated) {
            break;
          }

          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }

        clearTimeout(killTimeout);
        safeLog("debug", "All shards terminated successfully", "SHUTDOWN");
      } catch (err) {
        safeLog("warn", `Error waiting for shards to terminate: ${err}`, "SHUTDOWN");
        // Force destroy any lingering shards
        destroyShards();
      }
    }

    // Now that shards are handled, proceed with main process shutdown
    await handleApiError(
      "Failed to shut down gracefully",
      async () => {
        const shutdownManager = getShutdownManager();
        await shutdownManager.shutdown(0, reason);
      },
      {
        retries: 1,
        retryDelay: 1000,
        context: "Main Process Shutdown",
        reportAtSeverity: ErrorSeverity.HIGH,
      }
    );

    // Ensure process locks are removed
    removeProcessLock(ProcessType.MAIN);
    return;
  } catch (err) {
    safeLog("error", `Error during shutdown manager execution: ${String(err)}`, "SHUTDOWN");

    // Fallback database cleanup
    try {
      if (serviceRegistry.isAvailable("database")) {
        const db = serviceRegistry.get("database") as Database;
        await db.close();
        safeLog("info", "Database connections closed during fallback cleanup", "SHUTDOWN");
      }
    } catch (dbErr) {
      safeLog("error", `Failed to close database during fallback: ${String(dbErr)}`, "SHUTDOWN");
    }

    // Remove the process lock file
    removeProcessLock(ProcessType.MAIN);
  } finally {
    clearTimeout(forceExitTimeoutId);
    process.exit(0);
  }
};

/**
 * Set up process and environment for initialization
 */
function setupEnvironment(): boolean {
  // Prevent multiple initializations
  if (!acquireInitLock()) {
    safeLog(
      "warn",
      `Process ${process.pid} tried to initialize again, ignoring.`,
      `${processState.role.toUpperCase()}`
    );
    return false;
  }

  if (isShard()) {
    setupShardEnvironment();
  } else {
    setupMainEnvironment();
  }

  return true;
}

/**
 * Set up environment for shard process
 */
function setupShardEnvironment(): void {
  processState.role = ProcessRole.SHARD;
  processState.shardId = getShardId();
  process.env.IS_SHARD = "true";

  if (!createShardProcessLock(processState.shardId)) {
    safeLog(
      "error",
      "Failed to create shard lock file. Process may be unstable.",
      `${processState.role.toUpperCase()} ${processState.shardId}`
    );
  }

  trackInitState(`Shard ${processState.shardId} process starting`);
}

/**
 * Set up environment for main process
 */
function setupMainEnvironment(): void {
  processState.role = ProcessRole.MAIN;

  cleanupStaleLocks();

  if (!createMainProcessLock()) {
    safeLog(
      "error",
      "Another main process is already running. Exiting.",
      `${processState.role.toUpperCase()}`
    );
    exitProcess(1, "Another main process is already running");
    return;
  }

  trackInitState("Main process starting");

  // Check for command line parameter instead of config setting
  if (process.argv.includes("-debugInit")) {
    safeLog(
      "trace",
      `Main process successfully acquired lock with PID ${process.pid}`,
      `${processState.role.toUpperCase()}`
    );
    logMemoryUsage();
  }
}

/**
 * Set up core services needed by both main and shard processes
 */
async function setupCoreServices(): Promise<void> {
  logger.debug("Logger initialized.", `${processState.role.toUpperCase()}`);

  try {
    // Add initialization tracking
    logger.debug("Starting core services initialization", `${processState.role.toUpperCase()}`);

    // OPTIMIZATION: Only create Discord client when actually needed
    // For main process, create a minimal client just for rate limiting
    // For shards, create a full client
    const discordClient = _isShardProcess ? initDiscordClient() : new Client({ intents: [] }); // Minimal client for main process

    logger.debug("Discord client initialized", `${processState.role.toUpperCase()}`);

    // Create a local shutdown manager instance BEFORE anything tries to access it
    if (!_shutdownManagerInitialized && !_localShutdownManager) {
      // Only create if it doesn't exist and hasn't been initialized
      _localShutdownManager = createShutdownManager(discordClient);
      logger.debug("Shutdown manager created", `${processState.role.toUpperCase()}`);
    } else {
      logger.debug("Using existing shutdown manager", `${processState.role.toUpperCase()}`);
    }

    // Register it immediately to avoid circular dependency issues
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
      serviceRegistry.register(SERVICE_KEYS.SHUTDOWN_MANAGER, _localShutdownManager);
    }

    // Initialize the database
    const db = initializeDatabase(_configData, logger);
    logger.debug(`Database initialized successfully`, `${processState.role.toUpperCase()}`);
    serviceRegistry.register(SERVICE_KEYS.DATABASE, db);

    // Register threadManager before it's used
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      serviceRegistry.register(SERVICE_KEYS.THREAD_MANAGER, threadManager);
      logger.debug(`Thread manager registered successfully`, `${processState.role.toUpperCase()}`);
    }

    // Register cleanup tasks once
    // ...existing code...

    // OPTIMIZATION: User settings could be optimized to reduce redundant loading
    // Only load full settings in shard processes that need them
    if (_isShardProcess) {
      try {
        const UserSettingsModule = await import("./utilities/userSettings");
        const UserSettings = UserSettingsModule.default || UserSettingsModule;
        const emptyUserSettings = new UserSettings(db);
        serviceRegistry.register(SERVICE_KEYS.USER_SETTINGS, emptyUserSettings);
      } catch (err) {
        logger.error(
          `Failed to initialize user settings: ${err}`,
          `${processState.role.toUpperCase()}`
        );
      }
    } else {
      // For main process, create minimal settings service if needed
      // This could be a lightweight version that only loads what the main process needs
    }

    // Register client only if not already registered
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.CLIENT)) {
      serviceRegistry.register(SERVICE_KEYS.CLIENT, discordClient);
    }

    logger.debug("Core services initialization complete", `${processState.role.toUpperCase()}`);
    return Promise.resolve();
  } catch (error) {
    logger.error(`Failed to setup core services: ${error}`, `${processState.role.toUpperCase()}`);
    return Promise.reject(error);
  }
}

/**
 * Initialize shard-specific functionality
 */
async function initializeShardProcess(): Promise<void> {
  logger.trace(
    `Started running via process ${process.pid}`,
    `${processState.role.toUpperCase()} ${processState.shardId}`
  );

  // Get services from registry
  const client = serviceRegistry.get("client") as Client;

  await initBot(client);

  logger.debug(
    `Initialization completed successfully`,
    processState.role.toString() === "MAIN"
      ? processState.role.toUpperCase()
      : `${processState.role.toUpperCase()} ${processState.shardId}`
  );

  processState.isInitialized = true;

  // Set up message handlers for main process communication - only register once
  process.removeAllListeners("message"); // Remove any existing message listeners

  process.on("message", (message) => {
    if (typeof message === "object" && message !== null) {
      // Handle acknowledgment of our ready message
      if ("type" in message && message.type === "SHARD_READY_ACK") {
        logger.trace(`Main process acknowledged our ready status`, `SHARD ${processState.shardId}`);
      }
    }

    // For shutdown commands and other message types
    if (message === "shutdown") {
      logger.info(
        `Received shutdown command, shutting down`,
        processState.role.toString() === "MAIN"
          ? processState.role.toUpperCase()
          : `${processState.role.toUpperCase()} ${processState.shardId}`
      );

      // Acknowledge receipt back to the parent
      if (process.send) {
        try {
          process.send({ type: "SHUTDOWN_ACK", shardId: processState.shardId });
        } catch (err) {
          logger.debug(
            `Failed to acknowledge shutdown: ${err}`,
            processState.role.toString() === "MAIN"
              ? processState.role.toUpperCase()
              : `${processState.role.toUpperCase()} ${processState.shardId}`
          );
        }
      }

      if (serviceRegistry.isAvailable("shutdownManager")) {
        getShutdownManager()
          .shutdown(0, "Received shutdown command from main process")
          .catch((err) =>
            logger.error(
              `Error during shutdown: ${err}`,
              processState.role.toString() === "MAIN"
                ? processState.role.toUpperCase()
                : `${processState.role.toUpperCase()} ${processState.shardId}`
            )
          );
      } else {
        exitProcess(0, "Received shutdown command from main process");
      }
    }
  });

  // Now that we're fully initialized, tell the main process we're ready
  if (process.send) {
    try {
      process.send({
        type: "SHARD_READY",
        shardId: processState.shardId,
        timestamp: Date.now(),
      });
      logger.trace(`Sent ready signal to main process`, `SHARD ${processState.shardId}`);
    } catch (err) {
      logger.warn(
        `Failed to send ready signal to main process: ${err}`,
        `SHARD ${processState.shardId}`
      );
    }
  }

  // Set up signal handlers for shards - improved to handle coordination better
  process.on("SIGINT", () => {
    logger.debug(
      `Received SIGINT directly, waiting for main process coordination`,
      `${processState.role.toUpperCase()} ${processState.shardId}`
    );
    // DO NOT call shutdown here - parent process will coordinate
    // Set a safety timeout in case the parent process is unresponsive
    const safetyTimeout = DEFAULT_TIMEOUTS.SHARD_SAFETY_TIMEOUT;

    const safetyTimeoutId = setTimeout(() => {
      logger.warn(
        `No shutdown signal from parent process after ${safetyTimeout}ms, proceeding with self-shutdown`,
        `${processState.role.toUpperCase()} ${processState.shardId}`
      );
      exitProcess(0, "Parent process unresponsive during shutdown");
    }, safetyTimeout);

    // Clear timeout if we receive the expected shutdown message
    const messageHandler = (message: unknown) => {
      if (message === "shutdown") {
        clearTimeout(safetyTimeoutId);
        process.off("message", messageHandler); // Remove handler once we get the message
      }
    };
    process.on("message", messageHandler);
  });

  process.on("SIGTERM", () => {
    logger.debug(
      "Received SIGTERM directly, waiting for main process coordination",
      `${processState.role.toUpperCase()} ${processState.shardId}`
    );
    // DO NOT call shutdown here - parent process will coordinate
    // Set a safety timeout in case the parent process is unresponsive
    const safetyTimeout = DEFAULT_TIMEOUTS.SHARD_SAFETY_TIMEOUT;

    const safetyTimeoutId = setTimeout(() => {
      logger.warn(
        "No shutdown signal from parent process after 10s, proceeding with self-shutdown",
        `${processState.role.toUpperCase()} ${processState.shardId}`
      );
      exitProcess(0, "Parent process unresponsive during shutdown");
    }, safetyTimeout);

    // Clear timeout if we receive the expected shutdown message
    const messageHandler = (message: unknown) => {
      if (message === "shutdown") {
        clearTimeout(safetyTimeoutId);
        process.off("message", messageHandler); // Remove handler once we get the message
      }
    };
    process.on("message", messageHandler);
  });

  process.on("exit", (code) => {
    trackInitState(`Process ${process.pid} exit with code ${code}`);
    safeLog(
      "debug",
      `Process exit with code ${code}`,
      `${processState.role.toUpperCase()} ${processState.shardId}`
    );

    // Ensure we clean up the process lock
    if (processState.shardId !== undefined) {
      removeProcessLock(ProcessType.SHARD, processState.shardId);
    }
  });
}

/**
 * Handle Discord command setup and registration
 */
let commandsLoaded = false;

async function setupCommands(): Promise<void> {
  if (commandsLoaded) {
    logger.debug(`Commands already loaded, skipping redundant operations.`, "COMMANDS");
    return;
  }

  logger.debug(`Loading commands...`, "COMMANDS");
  await loadCommands();
  logger.debug(`Commands loaded.`, "COMMANDS");

  // Command registration and processing
  logger.debug(`Checking command registry parameters.`, "COMMANDS");
  const shouldRegisterCommands = await checkCommandChange();

  if (shouldRegisterCommands) {
    logger.debug("Registering commands...", "COMMANDS");
    await registerCommands(!process.argv.includes("-local"), _configData);
    await genCommandHash(true);
    logger.debug("Command registration completed.", "COMMANDS");
  } else {
    logger.debug(`No command changes detected. Skipping registration.`, "COMMANDS");
  }

  await handleSpecialCommandLineArgs();
  commandsLoaded = true;
}

/**
 * Process special command line arguments
 */
async function handleSpecialCommandLineArgs(): Promise<void> {
  if (process.argv.includes("-clear_commands")) {
    const local = process.argv.includes("-local");
    try {
      await clearCommands(local, _configData);
      logger.done(`Removed all ${local ? "local" : "global"} commands.`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to remove all ${local ? "local" : "global"} commands: ${errorMessage}`);
    }
  }

  if (process.argv.includes("-reg_commands")) {
    await registerCommands(!process.argv.includes("-local"), _configData);
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
 * Handle shard message processing with a clean, straightforward approach
 */
function handleShardMessage(shard: Shard, message: unknown): void {
  try {
    // Handle arrays of messages
    if (Array.isArray(message)) {
      const messageCollection = new Collection(
        message.map((item) => {
          if (typeof item === "object" && item !== null && "id" in item) {
            return [String(item.id), item];
          }
          return ["unknown", item];
        })
      );

      const threadMessages = messageCollection.filter(
        (msg) => typeof msg === "object" && msg !== null && "type" in msg && msg.type === "thread"
      );

      if (threadMessages.size > 0) {
        logger.trace(
          `Received ${threadMessages.size} thread-related messages from shard ${shard.id}`
        );
      }

      return;
    }

    // Handle string messages
    if (typeof message === "string") {
      logger.trace(`Shard ${shard.id} received message: ${message}`);
      return;
    }

    // Handle object messages
    if (message && typeof message === "object") {
      const msgObj = message as Record<string, unknown>;
      const messageType = typeof msgObj.type === "string" ? msgObj.type : null;

      // First handle special cases based on message properties
      if (msgObj._ready === true) {
        const shardId = typeof msgObj.id === "number" ? msgObj.id : shard.id;
        logger.done("Marked as ready by Discord.js", `SHARD ${shardId}`);
        return;
      }

      // Handle messages with type property
      if (messageType) {
        // Handle acknowledgment messages
        if (messageType.endsWith("_ACK") || messageType === "SHARD_READY") {
          const shardId = typeof msgObj.shardId === "number" ? msgObj.shardId : shard.id;

          // Log a proper message based on type
          if (messageType === "SHARD_INIT_ACK") {
            logger.debug(`Shard ${shardId} acknowledged initialization`, "SHARD_MANAGER");
          } else if (messageType === "SHARD_READY_ACK") {
            logger.debug(`Shard ${shardId} ready state acknowledged`, "SHARD_MANAGER");
          } else if (messageType === "SHUTDOWN_ACK") {
            logger.debug(`Shard ${shardId} acknowledged shutdown request`, "SHUTDOWN");
          } else if (messageType === "SHARD_READY") {
            logger.debug(`Shard ${shardId} reported ready status`, "SHARD_MANAGER");

            // Additional handling for SHARD_READY
            try {
              shard
                .send({
                  type: "SHARD_READY_ACK",
                  shardId: shardId,
                  timestamp: Date.now(),
                })
                .catch((err) =>
                  logger.debug(`Failed to acknowledge shard ${shardId} ready: ${err}`, "MAIN")
                );

              // Register with rate limit manager
              logger.debug(`Registering shard ${shardId} with rate limit manager`, "MAIN");

              import("./utilities/rateLimitManager")
                .then(() => {
                  logger.trace(`Shard ${shardId} registered with rate limit manager`, "MAIN");
                })
                .catch((err) => {
                  logger.error(`Error registering shard with rate limit manager: ${err}`, "MAIN");
                });
            } catch (err) {
              logger.debug(`Error acknowledging shard ${shardId} ready: ${err}`, "MAIN");
            }
          }

          return;
        }

        // Handle rate limit related messages
        if (messageType.includes("RATE_LIMIT")) {
          // Handle rate limit update - properly leverage the discord.js RateLimitData object
          if (messageType === "RATE_LIMIT_UPDATE") {
            const route = typeof msgObj.route === "string" ? msgObj.route : "";
            logger.trace(`Shard ${shard.id} reported rate limit for ${route}`, "RATE_LIMIT");

            // First check if the full RateLimitData object is available
            if (typeof msgObj.rateLimitData === "object" && msgObj.rateLimitData !== null) {
              // Use the full RateLimitData object directly as provided by discord.js
              rateLimitManager.handleRateLimit(msgObj.rateLimitData as RateLimitData);
              return;
            }

            // Fallback to using individual fields if they're provided
            if (typeof msgObj.route === "string") {
              const rateLimitData: Partial<RateLimitData> = {
                route: msgObj.route,
                // Map fields from our message to discord.js RateLimitData properties
                timeToReset:
                  typeof msgObj.timeToReset === "number"
                    ? msgObj.timeToReset
                    : typeof msgObj.reset === "number"
                      ? msgObj.reset
                      : 5000,
                limit: typeof msgObj.limit === "number" ? msgObj.limit : 0,
                method: typeof msgObj.method === "string" ? msgObj.method : "GET",
                url: typeof msgObj.url === "string" ? msgObj.url : "",
                global: typeof msgObj.global === "boolean" ? msgObj.global : false,
                hash: typeof msgObj.hash === "string" ? msgObj.hash : "",
                majorParameter:
                  typeof msgObj.majorParameter === "string" ? msgObj.majorParameter : "",
              };

              // Pass the best approximation of RateLimitData to the rate limit manager
              rateLimitManager.handleRateLimit(rateLimitData as RateLimitData);
              return;
            }
          }

          // Handle global rate limit
          if (messageType === "GLOBAL_RATE_LIMIT" && typeof msgObj.reset === "number") {
            const reset = msgObj.reset;

            logger.warn(
              `Shard ${shard.id} reported global rate limit with reset at ${new Date(reset).toISOString()}`,
              "RATE_LIMIT"
            );

            // For global rate limits, notify all shards
            _shardManager
              ?.broadcast({
                type: "GLOBAL_RATE_LIMIT_NOTIFICATION",
                reset,
                source: shard.id,
              })
              .catch((err) => {
                logger.error(`Failed to broadcast global rate limit: ${err}`, "RATE_LIMIT");
              });

            return;
          }

          // Handle rate limit request with headers
          if (
            messageType === "RATE_LIMIT_REQUEST" &&
            typeof msgObj.route === "string" &&
            typeof msgObj.requestId === "string" &&
            typeof msgObj.headers === "object" &&
            msgObj.headers !== null
          ) {
            const route = msgObj.route as string;
            const requestId = msgObj.requestId as string;
            const headers = msgObj.headers as Record<string, string>;

            // Use the proper public method to update from headers
            rateLimitManager.updateFromHeaders(route, headers);

            // Send response back to shard about current rate limit status
            try {
              const isLimited = rateLimitManager.isRateLimited(route);
              const resetTime = rateLimitManager.getRateLimitedUntil(route);

              shard
                .send({
                  type: "RATE_LIMIT_RESPONSE",
                  requestId,
                  route,
                  limited: isLimited,
                  reset: resetTime,
                  timestamp: Date.now(),
                })
                .catch((err) => {
                  logger.error(
                    `Failed to respond to rate limit request from shard ${shard.id}: ${err}`,
                    "RATE_LIMIT"
                  );
                });
            } catch (err) {
              logger.error(
                `Error sending rate limit response to shard ${shard.id}: ${err}`,
                "RATE_LIMIT"
              );
            }

            return;
          }
        }
      }

      // Handle operation-based messages
      const operation = typeof msgObj.op === "string" ? msgObj.op : null;
      if (operation) {
        if (operation === "KILL_SHARD") {
          try {
            shard.kill();
            logger.done(`Successfully killed shard ${shard.id}.`);
          } catch (err) {
            logger.error(`Error killing shard ${shard.id}: ${String(err)}`);
          }
          return;
        }

        if (operation === "RELOAD_COMMANDS") {
          reloadCommands();
          return;
        }
      }

      // Log the message content for trace purposes
      try {
        logger.trace(`Shard ${shard.id} received message: ${JSON.stringify(msgObj)}`);
      } catch {
        logger.trace(
          `Shard ${shard.id} received message that couldn't be stringified: ${typeof msgObj}`
        );
      }

      return;
    }

    // Handle other message types
    logger.trace(`Shard ${shard.id} received message of type: ${typeof message}`);
  } catch (error) {
    logger.error(`Error handling message from shard ${shard.id}: ${String(error)}`, "MAIN");
  }
}

/**
 * Configure a shard with event handlers
 */
function setupShardEventHandlers(shard: Shard): void {
  _shards.push(shard);
  logger.done(`Shard ${shard.id} spawned!`);

  // Track shard initialization timeouts for proper cleanup
  const shardTimeouts = new Map<string, NodeJS.Timeout>();

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
    if (!_shuttingDown) {
      logger.debug(`Shard ${shard.id} is reconnecting.`);
      webLog(`Shard ${shard.id} is reconnecting!`, null, Colors.DarkGreen).catch(() => {
        // Silent fail for webhook during reconnection is appropriate
      });
    }
  });

  shard.on("resume", () => {
    if (!_shuttingDown) logger.debug(`Shard ${shard.id} resumed.`);
  });

  shard.on("death", () => {
    if (!_shuttingDown) {
      logger.error(`Shard ${shard.id} died.`);
      webLog(`Shard ${shard.id} died!`, null, Colors.Red).catch(() => {
        // Silent fail for webhook during death is appropriate
      });
    } else {
      logger.debug(`Shard ${shard.id} died during shutdown.`);
    }
  });

  shard.on("disconnect", () => {
    if (!_shuttingDown) {
      logger.debug(`Shard ${shard.id} disconnected`);
      webLog(`Shard ${shard.id} disconnected`, "Connection closed", Colors.Orange).catch(() => {
        // Silent fail for webhook during disconnect is appropriate
      });
    }
  });

  shard.on("message", (message) => {
    // Process the message in handleShardMessage which knows how to handle all types
    handleShardMessage(shard, message);
  });

  // Cleanup function for when shards are destroyed
  shard.on("death", () => {
    // Clear all timeouts for this shard
    for (const [key, timeoutId] of shardTimeouts.entries()) {
      if (key.includes(`-${shard.id}`)) {
        clearTimeout(timeoutId);
        shardTimeouts.delete(key);
        logger.trace(`Cleared timeout ${key} for dead shard ${shard.id}`, "MAIN");
      }
    }
  });
}

/**
 * Create and configure the sharding manager
 */
function setupShardingManager(args: string[]): ShardingManager {
  logger.debug(`Creating ShardingManager.`, `${processState.role.toUpperCase()}`);

  const shardCount = getShardCount();
  const newManager = createShardingManager(args, shardCount);

  logger.debug(`ShardingManager created.`, `${processState.role.toUpperCase()}`);
  newManager.on("shardCreate", (shard) => setupShardEventHandlers(shard));

  _shardManager = newManager;

  // Register only once using the critical flag
  if (serviceRegistry && typeof serviceRegistry.register === "function") {
    try {
      serviceRegistry.register("shardManager", newManager);
      logger.debug(
        "Service 'shardManager' registered successfully",
        `${processState.role.toUpperCase()}`
      );
    } catch (error) {
      logger.warn(
        `Failed to register 'shardManager' service: ${error instanceof Error ? error.message : String(error)}`,
        `${processState.role.toUpperCase()}`
      );
    }
  }

  return newManager;
}

/**
 * Get shard count from config or use "auto" as fallback
 */
function getShardCount(): number | "auto" {
  return _configData.shardCount !== undefined ? _configData.shardCount : 1;
}

/**
 * Returns the correct path to package.json based on environment
 */
export function getPackageJsonPath(): string {
  return process.env.NODE_ENV === "production"
    ? "/usr/src/bot/package.json" // Path in Docker
    : "./package.json"; // Path for local development
}

/**
 * Create a new ShardingManager instance
 */
function createShardingManager(args: string[], shardCount: number | "auto"): ShardingManager {
  logger.debug(
    `Configuring ShardingManager with totalShards: ${shardCount}`,
    `${processState.role.toUpperCase()}`
  );

  // Use path.join for reliable file paths across environments
  const scriptPath =
    process.env.NODE_ENV === "production"
      ? "/usr/src/bot/dist/index.js" // Path in Docker
      : "./dist/index.js"; // Path for local development

  logger.debug(`Using shard script path: ${scriptPath}`, "SHARD_MANAGER");

  return new ShardingManager(scriptPath, {
    totalShards: shardCount,
    shardArgs: args,
    token: _configData.tokens.discord,
    respawn: true,
  });
}

/**
 * Spawn shards with proper error handling and timeouts
 */
async function spawnShards(manager: ShardingManager): Promise<void> {
  if (_shardSpawningInProgress) {
    logger.warn(
      "Shard spawning already in progress, skipping duplicate request",
      `${processState.role.toUpperCase()}`
    );
    return;
  }

  _shardSpawningInProgress = true;

  try {
    if (manager.shards.size > 0) {
      logger.info(
        `${manager.shards.size} shards already active, skipping spawn`,
        `${processState.role.toUpperCase()}`
      );
      _shardSpawningInProgress = false;
      return;
    }

    await performShardSpawn(manager);
  } finally {
    if (_spawnTimeoutId) {
      clearTimeout(_spawnTimeoutId);
      _spawnTimeoutId = null;
      logger.debug(`Cleared shard spawn safety timeout`, `${processState.role.toUpperCase()}`);
    }
    _shardSpawningInProgress = false;
  }
}

async function performShardSpawn(manager: ShardingManager): Promise<void> {
  // Get timeout value directly from defaults or shardTimeouts config
  const spawnTimeout = DEFAULT_TIMEOUTS.SHARD_SPAWN_TIMEOUT;

  logger.debug(
    `Starting shard spawn process with timeout of ${spawnTimeout / 1000} seconds`,
    `${processState.role.toUpperCase()}`
  );

  if (_spawnTimeoutId) clearTimeout(_spawnTimeoutId);

  _spawnTimeoutId = setTimeout(
    () => handleSpawnTimeout(manager, spawnTimeout),
    spawnTimeout + 10000
  );

  const spawnOptions = {
    timeout: spawnTimeout,
    ...(manager.shardList.length > 0 ? { shardList: manager.shardList } : {}),
  };

  const shardCountToSpawn = getShardCountToSpawn(manager);

  logger.debug(`Spawning ${shardCountToSpawn} shard(s)...`, `${processState.role.toUpperCase()}`);

  try {
    await manager.spawn(spawnOptions);
    clearSpawnTimeout();
    logger.debug(
      `Successfully spawned ${manager.shards.size} shards`,
      `${processState.role.toUpperCase()}`
    );
  } catch (spawnError) {
    handleSpawnError(manager, spawnError);
  }
}

function getShardCountToSpawn(manager: ShardingManager): number | "auto" {
  return Array.isArray(manager.shardList) && manager.shardList.length > 0
    ? manager.shardList.length
    : typeof manager.totalShards === "number"
      ? manager.totalShards
      : "auto";
}

function handleSpawnTimeout(manager: ShardingManager, spawnTimeout: number): void {
  logger.warn(
    `Shard spawn safety timeout (${spawnTimeout / 1000}s) triggered, but continuing anyway`,
    `${processState.role.toUpperCase()}`
  );

  if (manager.shards.size > 0) {
    logger.info(
      `Found ${manager.shards.size} active shards despite timeout`,
      `${processState.role.toUpperCase()}`
    );
    verifyShardResponsiveness(manager);
  }
}

function clearSpawnTimeout(): void {
  if (_spawnTimeoutId) {
    clearTimeout(_spawnTimeoutId);
    _spawnTimeoutId = null;
  }
}

async function verifyShardResponsiveness(manager: ShardingManager): Promise<void> {
  try {
    const results = await manager.broadcastEval(() => "ready");
    logger.info(`Verified ${results.length} responsive shards despite timeout`, "SHARD_SPAWN");
  } catch (err) {
    logger.warn(`Failed to verify shard responsiveness: ${err}`, "SHARD_SPAWN");
  }
}

async function handleSpawnError(manager: ShardingManager, spawnError: unknown): Promise<void> {
  clearSpawnTimeout();

  const errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);

  if (errorMessage.includes("took too long to become ready") && manager.shards.size > 0) {
    logger.warn(
      `Shard readiness timeout, but ${manager.shards.size} shard(s) are active. Proceeding normally.`,
      `${processState.role.toUpperCase()}`
    );
    await verifyShardResponsiveness(manager);
    return;
  }

  logger.error(`Failed to spawn shards: ${errorMessage}`, `${processState.role.toUpperCase()}`);

  if (manager.shards.size === 0) {
    throw spawnError;
  } else {
    logger.warn(
      `Proceeding with ${manager.shards.size} active shards despite spawn errors`,
      `${processState.role.toUpperCase()}`
    );
  }
}

/**
 * Initialize auxiliary services (top.gg, backups, stats)
 */
async function initializeAuxiliaryServices(): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (_configData.tokens.topgg) {
    tasks.push(initializeTopGG());
  }

  if (_configData.database.backupInterval) {
    tasks.push(initializeBackups());
  }

  if (_configData.statsServer.enabled) {
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
      const manager = getShardManager();
      if (!manager) {
        throw new Error("Shard manager not available for top.gg autoposter");
      }
      AutoPoster(_configData.tokens.topgg, manager);
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
      if (!serviceRegistry.isAvailable("database")) {
        throw new Error("Database service not available for backups");
      }

      const db = serviceRegistry.get("database") as Database;
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
      const manager = getShardManager();
      if (!manager) {
        throw new Error("Shard manager not available for stats server");
      }

      if (!serviceRegistry.isAvailable("database")) {
        throw new Error("Database service not available for stats server");
      }

      const db = serviceRegistry.get("database") as Database;
      start(manager, _configData.statsServer.port, db);
      logger.info(`Stats server started on port ${_configData.statsServer.port}`);

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
  logger.debug(`Initialization started via process ${process.pid}`, "INIT");

  const args = process.argv.slice(2).filter((arg) => arg !== "--is-shard");

  // Create and register shardManager BEFORE loading commands
  const manager = setupShardingManager(args);

  // Wait a moment to ensure the service registration completes
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Now load commands after shardManager is registered
  await setupCommands();
  setupMainProcessErrorHandlers();

  await spawnShards(manager);

  // Initialize auxiliary services (top.gg, backups, stats server)
  await initializeAuxiliaryServices();

  await registerShutdownTask();
}

/**
 * Initialize function handling both shard and main processes
 */
export const initialize = async (): Promise<void> => {
  if (_isStartupInProgress) {
    logger.warn("Initialization already in progress, ignoring duplicate call");
    return;
  }

  logger.trace(
    `Process ${process.pid} initializing (${isShard() ? "shard" : "main"})`,
    `${processState.role.toUpperCase()}`
  );
  _isStartupInProgress = true;

  try {
    if (!setupEnvironment()) {
      _isStartupInProgress = false;
      return;
    }

    logger.trace(
      "Environment setup complete, initializing core services",
      `${processState.role.toUpperCase()}`
    );
    await setupCoreServices();
    logger.trace("Core services initialized", `${processState.role.toUpperCase()}`);

    if (isShard()) {
      await initializeShard();
    } else {
      await initializeMain();
    }

    logger.trace(
      `Process ${process.pid} initialization complete`,
      `${processState.role.toUpperCase()}`
    );
    _applicationStartupComplete = true;
    _isStartupInProgress = false;

    if (!_messagesSuppressed) {
      logger.info(
        `${isShard() ? `Shard ${getShardId()}` : "Main process"} initialization complete`
      );
      _messagesSuppressed = true;
    }
  } catch (err) {
    handleInitializationError(err);
  }
};

const initializeShard = async (): Promise<void> => {
  logger.trace(`Initializing shard process ${getShardId()}`, `${processState.role.toUpperCase()}`);
  await initializeShardProcess();
};

const initializeMain = async (): Promise<void> => {
  logger.trace("Initializing main process", `${processState.role.toUpperCase()}`);
  await initializeMainProcess();
};

const handleInitializationError = (err: unknown): void => {
  logger.error(`Initialization error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    logger.debug(`Initialization stack trace: ${err.stack}`);
  }

  _isStartupInProgress = false;

  const timeoutId = setTimeout(() => {
    if (!_isShardProcess) {
      handleMainShutdown("initialization failure").catch((e) =>
        logger.error(`Error during shutdown after initialization failure: ${e}`)
      );
    } else {
      exitProcess(1, "Shard initialization failed");
    }
  }, 2000);

  _initTimeouts.add(timeoutId);
};

// Set up entry point logic
function setupEntryPoint(): void {
  if (require.main === module && !_hasInitialized) {
    _hasInitialized = true;
    trackInitState("Entry point execution");

    // Log startup at info level but only once
    if (!_applicationStartupComplete && !_messagesSuppressed) {
      logger.trace(
        `Thread-Watcher starting (${isMainProcess() ? "main" : "shard"} process ${process.pid})`,
        "STARTUP"
      );
      _messagesSuppressed = true;
    }

    // Add error handlers before doing anything else
    process.on("unhandledRejection", (reason) => {
      const reasonStr = reason instanceof Error ? reason.message : String(reason);
      logger.error(`Unhandled Rejection: ${reasonStr}`);
      if (reason instanceof Error && reason.stack) {
        logger.error(`Stack trace: ${reason.stack}`);
      }
    });

    process.on("uncaughtException", (err) => {
      logger.error("[FATAL ERROR] encountered in the main process.");
      logger.error(err instanceof Error ? err.message : String(err));
      if (err.stack) logger.error(err.stack);

      // Don't call handleMainShutdown here to avoid potential loops
      // Just exit the process after a delay
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    });

    // Wrap the initialize call in a try/catch for extra safety
    try {
      logger.trace("Starting initialization process", "STARTUP");

      initialize().catch((err) => {
        logger.error(
          `Critical initialization error: ${err instanceof Error ? err.message : String(err)}`
        );

        if (err instanceof Error && err.stack) {
          logger.debug(`Error stack trace: ${err.stack}`);
        }

        // Add a delay before exit to prevent rapid restart loops
        const timeoutId = setTimeout(() => {
          exitProcess(
            1,
            `Initialization failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }, 2000);

        // Track timeout for potential cleanup
        _initTimeouts.add(timeoutId);
      });
    } catch (err) {
      logger.error(`Critical error during initialization setup: ${err}`);

      // Add a delay before exit to prevent rapid restart loops
      const timeoutId = setTimeout(() => {
        process.exit(1);
      }, 3000);

      // Track timeout for potential cleanup
      _initTimeouts.add(timeoutId);
    }

    // Set up process signal handlers - only register what's needed based on process role
    if (!isShard()) {
      // Main process already has signal handlers from shutdownManager
      // Just add the exit handler for cleanup
      process.on("exit", (code) => {
        trackInitState(`Process ${process.pid} exit with code ${code}`);
        safeLog("debug", `Process exit with code ${code} - cleaning up`, "EXIT");
        if (_shuttingDown) {
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
          `Process exit with code ${code}`,
          `${processState.role.toUpperCase()} ${processState.shardId}`
        );
      });
    }
  }

  // Ensure we handle signals properly
  process.on("SIGINT", () => {
    logger.info("Received SIGINT signal");
    exitProcess(0, "SIGINT");
  });

  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM signal");
    exitProcess(0, "SIGTERM");
  });

  // Add handler for cleanup at exit
  process.on("exit", (code) => {
    logger.debug(`Process exit with code ${code} - cleaning up`, "MAIN");

    // Make sure we don't leave any dangling child processes
    const manager = getShardManager();
    if (manager) {
      try {
        logger.debug("Ensuring no orphaned shards remain");
        manager.shards.forEach((shard) => {
          try {
            process.kill(shard.process?.pid || 0, "SIGTERM");
          } catch {
            // Ignore errors trying to terminate already exited processes
          }
        });
      } catch {
        // Ignore any cleanup errors during exit
      }
    }

    // Ensure we remove process lock files
    if (isMainProcess()) {
      removeProcessLock(ProcessType.MAIN);
    } else if (processState.shardId !== undefined) {
      removeProcessLock(ProcessType.SHARD, processState.shardId);
    }

    // Clear all initialization timeouts
    for (const timeoutId of _initTimeouts) {
      clearTimeout(timeoutId);
    }
    _initTimeouts.clear();

    // Clear all tracked shard timeouts
    for (const timeoutId of _shardTimeoutMap.values()) {
      clearTimeout(timeoutId);
    }
    _shardTimeoutMap.clear();
  });
}

// Call the setupEntryPoint function
setupEntryPoint();

// Export necessary objects and functions
export { _configData as config };

/**
 * Get the ShardManager instance
 * @returns The ShardManager instance or undefined if not initialized
 */
export function getShardManager(): ShardingManager | undefined {
  try {
    // Try to use service registry first if available
    if (
      serviceRegistry &&
      serviceRegistry.isAvailable &&
      serviceRegistry.isAvailable("shardManager")
    ) {
      return serviceRegistry.get("shardManager");
    }

    // Fall back to module variable if service registry not available
    if (_shardManager) {
      return _shardManager;
    }

    // Log with appropriate severity based on initialization state
    if (_isStartupInProgress) {
      logger.debug("ShardManager requested during initialization - not available yet");
    } else {
      logger.warn("ShardManager requested but not available");
    }

    return undefined;
  } catch (err) {
    // Handle errors gracefully
    logger.debug(
      `Error accessing shardManager: ${err instanceof Error ? err.message : String(err)}`
    );
    return _shardManager || undefined;
  }
}

/**
 * Register shutdown task for thread monitoring cleanup
 */
async function registerShutdownTask(): Promise<void> {
  if (_localShutdownManager && !_taskRegistrationComplete) {
    _localShutdownManager.registerCleanupTask(
      async () => {
        if (threadManager) {
          await threadManager.stopThreadMonitoring();
          logger.debug("Thread monitoring stopped during shutdown");
        }
      },
      {
        name: "Thread_Maintenance_Cleanup_Task",
        priority: ShutdownPriority.NORMAL,
        timeout: 3000,
      }
    );

    // Mark task as registered to prevent duplicate registration
    _taskRegistrationComplete = true;
  }
}

// Import necessary utilities

// Setup proper signal handling for the current process type
initializeShutdownHandlers(isShard());
export { serviceRegistry } from "./services";
