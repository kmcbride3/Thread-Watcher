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
} from "discord.js"
import { AutoPoster } from "topgg-autoposter"
import { initBot } from "./bot"
import { Database } from "./interfaces/database"
import { SERVICE_KEYS, serviceRegistry } from "./services"
import { getConfig } from "./utilities/cnf"
import { initializeDatabase } from "./utilities/database/DatabaseManager"
import { logMemoryUsage, trackInitState } from "./utilities/debugUtils"
import { ErrorSeverity, handleApiError } from "./utilities/errorSystem"
import { EventManager, registerEventManager } from "./utilities/eventManager"
import loadCommands from "./utilities/loadCommands"
import { initLogger, logToFile, safeLog } from "./utilities/logger"
import { messageRouter } from "./utilities/messageRouter"
import {
  getShardId,
  isMainProcess,
  isShard,
  ProcessRole,
  processState,
} from "./utilities/processState"
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
  initializeShutdownHandlers,
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
import { threadManager } from "./utilities/threadManager"
import start from "./web"

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
registerEventManager();

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
  // Fix: Use the correct event name "rateLimited" (lowercase l) for discord.js v14.18.0
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

  // Validate the webhook URL and use it for the webhook client
  let webhookUrl: URL;
  try {
    webhookUrl = new URL(_configData.logWebhook);
  } catch {
    safeLog("error", "Invalid webhook URL provided in _configData.logWebhook", "WEBHOOK");
    return;
  }

  try {
    const webhookClient = new WebhookClient({ url: webhookUrl.toString() });
    const embed = new EmbedBuilder().setTitle(title).setTimestamp(new Date()).setColor(color);

    if (description) embed.setDescription(description);

    const logMessage = `${title}: ${description || ""}`;
    logToFile(logMessage);

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
  // Set global shutdown flag
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

  try {
    // Notify all shards to shut down
    const shardManager = await getShardManager();
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

      // Give shards time to begin their shutdown sequence
      safeLog(
        "debug",
        `Waiting for shards to acknowledge shutdown (${DEFAULT_TIMEOUTS.SHARD_SHUTDOWN_GRACE}ms grace period)`,
        "SHUTDOWN"
      );
      await new Promise<void>((resolve) =>
        setTimeout(resolve, DEFAULT_TIMEOUTS.SHARD_SHUTDOWN_GRACE)
      );

      // Now wait for shards to process their shutdown sequence
      try {
        safeLog(
          "debug",
          `Waiting up to ${DEFAULT_TIMEOUTS.SHARD_SHUTDOWN_MAX_WAIT}ms for shards to terminate`,
          "SHUTDOWN"
        );

        // Set a timeout to force kill any remaining shards
        const killTimeout = setTimeout(() => {
          safeLog("warn", "Shard shutdown timeout exceeded, forcing termination", "SHUTDOWN");
          destroyShards();
        }, DEFAULT_TIMEOUTS.SHARD_SHUTDOWN_MAX_WAIT);

        // Check for up to maxWaitTime if shards are terminated
        const endTime = Date.now() + DEFAULT_TIMEOUTS.SHARD_SHUTDOWN_MAX_WAIT;
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

    // Get the shutdown manager to handle the rest of the process
    const shutdownManager = await serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER)

    // Let the shutdown manager handle the actual exit
    await shutdownManager.shutdown(0, reason);

    // This point should never be reached as shutdown() exits the process
    return;
  } catch (err) {
    safeLog("error", `Error during shutdown manager execution: ${String(err)}`, "SHUTDOWN");

    // Use exitProcess from shutdown.ts for consistent behavior
    exitProcess(1, `Failed shutdown: ${String(err)}`);
  }
};

/**
 * Set up process and environment for initialization
 */
function setupEnvironment(): boolean {
  // Correctly uses acquireInitLock from startup.ts
  if (!acquireInitLock()) {
    safeLog(
      "warn",
      `Process ${process.pid} tried to initialize again, ignoring.`,
      processState.role.toUpperCase()
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

  // Correctly uses createShardProcessLock from startup.ts
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

  // Correctly uses cleanupStaleLocks from startup.ts
  cleanupStaleLocks();

  // Correctly uses createMainProcessLock from startup.ts
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
    if (!_localShutdownManager) {
      // Only create if it doesn't exist
      _localShutdownManager = createShutdownManager(discordClient, handleMainShutdown);
      logger.debug("Shutdown manager created", `${processState.role.toUpperCase()}`);
    } else {
      logger.debug("Using existing shutdown manager", `${processState.role.toUpperCase()}`);
    }

    // Register it immediately to avoid circular dependency issues
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
      serviceRegistry.register(SERVICE_KEYS.SHUTDOWN_MANAGER, _localShutdownManager);
    }

    // Initialize the database
    const db = await initializeDatabase(_configData, logger)
    logger.debug("Database initialized successfully", `${processState.role.toUpperCase()}`);
    serviceRegistry.register(SERVICE_KEYS.DATABASE, db);

    // Register threadManager before it's used
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      serviceRegistry.register(SERVICE_KEYS.THREAD_MANAGER, threadManager);
      logger.debug("Thread manager registered successfully", `${processState.role.toUpperCase()}`)
    }

    if (!serviceRegistry.isAvailable(SERVICE_KEYS.MESSAGE_ROUTER)) {
      serviceRegistry.register(SERVICE_KEYS.MESSAGE_ROUTER, messageRouter)
      logger.debug("Message router registered successfully", `${processState.role.toUpperCase()}`);
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

  const client = (await serviceRegistry.get(SERVICE_KEYS.CLIENT)) as Client;

  await initBot(client);

  logger.debug(
    "Initialization completed successfully",
    processState.role.toString() === "MAIN"
      ? processState.role.toUpperCase()
      : `${processState.role.toUpperCase()} ${processState.shardId}`
  );

  processState.isInitialized = true;

  // Register the shard message handler through the centralized router
  messageRouter.registerHandler(
    async (message) => {
      if (typeof message === "object" && message !== null) {
        // Handle acknowledgment of our ready message
        if ("type" in message && message.type === "SHARD_READY_ACK") {
          logger.trace(
            "Main process acknowledged our ready status",
            `SHARD ${processState.shardId}`
          )
        }
      }

      // For shutdown commands and other message types
      if (message === "shutdown") {
        logger.info(
          "Received shutdown command, shutting down",
          processState.role.toString() === "MAIN"
            ? processState.role.toUpperCase()
            : `${processState.role.toUpperCase()} ${processState.shardId}`
        );

        // Acknowledge receipt back to the parent
        if (process.send) {
          try {
            process.send({ type: "SHUTDOWN_ACK", shardId: processState.shardId })
          } catch (err) {
            logger.debug(
              `Failed to acknowledge shutdown: ${err}`,
              processState.role.toString() === "MAIN"
                ? processState.role.toUpperCase()
                : `${processState.role.toUpperCase()} ${processState.shardId}`
            )
          }
        }

        if (serviceRegistry.isAvailable(SERVICE_KEYS.SHUTDOWN_MANAGER)) {
          const manager = await serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER)
          manager
            .shutdown(0, "Received shutdown command from main process")
            .catch((err) =>
              logger.error(
                `Error during shutdown: ${err}`,
                processState.role.toString() === "MAIN"
                  ? processState.role.toUpperCase()
                  : `${processState.role.toUpperCase()} ${processState.shardId}`
              )
          )
        } else {
          exitProcess(0, "Received shutdown command from main process")
        }
      }
    },
    {
      id: "main-shard-handler",
      name: "Main Shard Message Handler",
      priority: 10, // High priority
    }
  );

  // Now that we're fully initialized, tell the main process we're ready
  if (process.send) {
    try {
      process.send({
        type: "SHARD_READY",
        shardId: processState.shardId,
        timestamp: Date.now(),
      });
      logger.trace("Sent ready signal to main process", `SHARD ${processState.shardId}`);
    } catch (err) {
      logger.warn(
        `Failed to send ready signal to main process: ${err}`,
        `SHARD ${processState.shardId}`
      );
    }
  }

  // Set up signal handlers for shards with improved coordination
  process.on("SIGINT", () => {
    logger.debug(
      "Received SIGINT directly, waiting for main process coordination",
      `${processState.role.toUpperCase()} ${processState.shardId}`
    );

    const safetyTimeout = DEFAULT_TIMEOUTS.SHARD_SAFETY_TIMEOUT;
    const safetyTimeoutId = setTimeout(() => {
      logger.warn(
        `No shutdown signal from parent process after ${safetyTimeout}ms, proceeding with self-shutdown`,
        `${processState.role.toUpperCase()} ${processState.shardId}`
      );
      exitProcess(0, "Parent process unresponsive during shutdown");
    }, safetyTimeout);

    // Use messageRouter instead of adding another process.on("message") listener
    const handlerId = messageRouter.registerHandler(
      (message) => {
        if (message === "shutdown") {
          clearTimeout(safetyTimeoutId);
          messageRouter.removeHandler(handlerId) // Clean up this temporary handler
        }
      },
      {
        id: `sigint-safety-${Date.now()}`,
        name: "SIGINT Safety Handler",
        filter: (message) => message === "shutdown",
        priority: 100, // Very high priority
      }
    );
  });

  // Handle SIGTERM similarly
  process.on("SIGTERM", () => {
    logger.debug(
      "Received SIGTERM directly, waiting for main process coordination",
      `${processState.role.toUpperCase()} ${processState.shardId}`
    );

    const safetyTimeout = DEFAULT_TIMEOUTS.SHARD_SAFETY_TIMEOUT;
    const safetyTimeoutId = setTimeout(() => {
      logger.warn(
        "No shutdown signal from parent process after 10s, proceeding with self-shutdown",
        `${processState.role.toUpperCase()} ${processState.shardId}`
      );
      exitProcess(0, "Parent process unresponsive during shutdown");
    }, safetyTimeout);

    // Use messageRouter for the temporary handler
    const handlerId = messageRouter.registerHandler(
      (message) => {
        if (message === "shutdown") {
          clearTimeout(safetyTimeoutId);
          messageRouter.removeHandler(handlerId)
        }
      },
      {
        id: `sigterm-safety-${Date.now()}`,
        name: "SIGTERM Safety Handler",
        filter: (message) => message === "shutdown",
        priority: 100, // Very high priority
      }
    );
  });

  process.on("exit", (code) => {
    trackInitState(`Process ${process.pid} exit with code ${code}`);
    safeLog(
      "debug",
      `Process exit with code ${code}`,
      `${processState.role.toUpperCase()} ${processState.shardId}`
    );

    // Clean up all message handlers
    messageRouter.removeAllHandlers();

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
    logger.debug("Commands already loaded, skipping redundant operations.", "COMMANDS");
    return;
  }

  logger.trace("Loading commands...", "COMMANDS");
  await loadCommands();
  logger.debug("Commands loaded.", "COMMANDS");

  // Command registration and processing
  logger.debug("Checking command registry parameters.", "COMMANDS");
  const shouldRegisterCommands = await checkCommandChange();

  if (shouldRegisterCommands) {
    logger.debug("Registering commands...", "COMMANDS");
    await registerCommands(!process.argv.includes("-local"), _configData);
    await genCommandHash(true);
    logger.debug("Command registration completed.", "COMMANDS");
  } else {
    logger.debug("No command changes detected. Skipping registration.", "COMMANDS");
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

          // Global tracking to ensure we only process one SHARD_READY event per shard
          // no matter how many times it's received or from where
          const readyShardKey = `shard-ready-${shardId}`

          if (messageType === "SHARD_READY") {
            // Check if we already processed a ready message for this shard in this session
            if (_shardTimeoutMap.has(readyShardKey)) {
              return // Skip duplicate ready messages completely
            }

            // Set a token in the map to mark this shard as having reported ready
            // The token will remain during the session to prevent duplicate processing
            _shardTimeoutMap.set(
              readyShardKey,
              setTimeout(
                () => {
                  // This timeout should never run during normal operation
                  // This is only for preventing memory leaks during long sessions
                  _shardTimeoutMap.delete(readyShardKey)
                },
                24 * 60 * 60 * 1000
              )
            ) // Clear after 24 hours to prevent memory leaks

            logger.debug(`Shard ${shardId} reported ready status`, "SHARD_MANAGER");

            // Process registration only once per shard
            logger.debug(`Registering shard ${shardId} with rate limit manager`, "MAIN");

            try {
              shard
                .send({
                  type: "SHARD_READY_ACK",
                  shardId,
                  timestamp: Date.now(),
                })
                .catch((err) =>
                  logger.debug(`Failed to acknowledge shard ${shardId} ready: ${err}`, "MAIN")
                );

              // Register with rate limit manager
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
          } else if (messageType === "SHARD_INIT_ACK") {
            logger.debug(`Shard ${shardId} acknowledged initialization`, "SHARD_MANAGER")
          } else if (messageType === "SHARD_READY_ACK") {
            logger.debug(`Shard ${shardId} ready state acknowledged`, "SHARD_MANAGER")
          } else if (messageType === "SHUTDOWN_ACK") {
            logger.debug(`Shard ${shardId} acknowledged shutdown request`, "SHUTDOWN");
          }

          return;
        }

        // Simplified rate limit handling - delegate to rateLimitManager
        if (messageType.includes("RATE_LIMIT")) {
          // Import dynamically to avoid circular dependencies
          import("./utilities/rateLimitManager")
            .then(({ rateLimitManager }) => {
              // The rateLimitManager has its own IPC message handling system
              // Pass the whole message object to it
              if (messageType === "RATE_LIMIT_UPDATE" && typeof msgObj.rateLimitData === "object") {
                rateLimitManager.handleRateLimit(msgObj.rateLimitData as RateLimitData);
              } else if (messageType === "GLOBAL_RATE_LIMIT" && typeof msgObj.reset === "number") {
                // Just log the global rate limit and broadcast to other shards
                logger.warn(
                  `Shard ${shard.id} reported global rate limit with reset at ${new Date(msgObj.reset as number).toISOString()}`,
                  "RATE_LIMIT"
                );

                // Broadcast to other shards
                _shardManager
                  ?.broadcast({
                    type: "GLOBAL_RATE_LIMIT_NOTIFICATION",
                    reset: msgObj.reset,
                    source: shard.id,
                  })
                  .catch((err) => {
                    logger.error(`Failed to broadcast global rate limit: ${err}`, "RATE_LIMIT")
                  });
              }
            })
            .catch((err) => {
              logger.error(`Error importing rateLimitManager: ${err}`, "RATE_LIMIT")
            });

          return;
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

  // Set up shard event handlers using EventManager
  EventManager.addHandler(shard, "error", `shard-${shard.id}-error`, (error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Shard ${shard.id} encountered an error: ${errorMessage}`);
  });

  EventManager.addHandler(shard, "ready", `shard-${shard.id}-ready`, () => {
    logger.trace(`Shard ${shard.id} is ready.`);
    webLog(`Shard ${shard.id} ready!`, null, Colors.Green).catch((err) =>
      logger.error(`Failed to send webhook for shard ${shard.id} ready: ${String(err)}`)
    );
  });

  EventManager.addHandler(shard, "reconnecting", `shard-${shard.id}-reconnecting`, () => {
    if (!_shuttingDown) {
      logger.debug(`Shard ${shard.id} is reconnecting.`);
      webLog(`Shard ${shard.id} is reconnecting!`, null, Colors.DarkGreen).catch(() => {
        // Silent fail for webhook during reconnection is appropriate
      });
    }
  });

  EventManager.addHandler(shard, "resume", `shard-${shard.id}-resume`, () => {
    if (!_shuttingDown) logger.debug(`Shard ${shard.id} resumed.`);
  });

  EventManager.addHandler(shard, "death", `shard-${shard.id}-death`, () => {
    if (!_shuttingDown) {
      logger.error(`Shard ${shard.id} died.`);
      webLog(`Shard ${shard.id} died!`, null, Colors.Red).catch(() => {
        // Silent fail for webhook during death is appropriate
      });
    } else {
      logger.debug(`Shard ${shard.id} died during shutdown.`);
    }
  });

  EventManager.addHandler(shard, "disconnect", `shard-${shard.id}-disconnect`, () => {
    if (!_shuttingDown) {
      logger.debug(`Shard ${shard.id} disconnected`);
      webLog(`Shard ${shard.id} disconnected`, "Connection closed", Colors.Orange).catch(() => {
        // Silent fail for webhook during disconnect is appropriate
      });
    }
  });

  EventManager.addHandler(shard, "message", `shard-${shard.id}-message`, (message) => {
    // Process the message in handleShardMessage which knows how to handle all types
    handleShardMessage(shard, message);
  });

  // Cleanup function for when shards are destroyed - register with EventManager
  EventManager.addHandler(shard, "death", `shard-${shard.id}-cleanup`, () => {
    // Clear all timeouts for this shard
    for (const [key, timeoutId] of shardTimeouts.entries()) {
      if (key.includes(`-${shard.id}`)) {
        clearTimeout(timeoutId);
        shardTimeouts.delete(key);
        logger.trace(`Cleared timeout ${key} for dead shard ${shard.id}`, "MAIN");
      }
    }

    // Clean up all event handlers for this shard
    EventManager.removeHandler(shard, "error", `shard-${shard.id}-error`)
    EventManager.removeHandler(shard, "ready", `shard-${shard.id}-ready`)
    EventManager.removeHandler(shard, "reconnecting", `shard-${shard.id}-reconnecting`)
    EventManager.removeHandler(shard, "resume", `shard-${shard.id}-resume`)
    EventManager.removeHandler(shard, "death", `shard-${shard.id}-death`)
    EventManager.removeHandler(shard, "disconnect", `shard-${shard.id}-disconnect`)
    EventManager.removeHandler(shard, "message", `shard-${shard.id}-message`)
    // Don't remove the cleanup handler itself as it's called during death event
  });
}

/**
 * Create and configure the sharding manager
 */
function setupShardingManager(args: string[]): ShardingManager {
  logger.trace("Creating ShardingManager.", `${processState.role.toUpperCase()}`);

  const shardCount = getShardCount();
  const newManager = createShardingManager(args, shardCount);

  logger.debug("ShardingManager created.", `${processState.role.toUpperCase()}`);
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
      logger.debug("Cleared shard spawn safety timeout", `${processState.role.toUpperCase()}`);
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
    async () => {
      // Fix: Use SERVICE_KEYS constant for consistency
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        throw new Error("Database service not available for backups");
      }

      const db = (await serviceRegistry.get(SERVICE_KEYS.DATABASE)) as Database;
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
    async () => {
      const manager = await getShardManager()
      if (!manager || !("shards" in manager)) {
        throw new Error("Valid ShardManager not available for stats server");
      }

      // Fix: Use SERVICE_KEYS constant for consistency
      if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
        throw new Error("Database service not available for stats server");
      }

      const db = (await serviceRegistry.get(SERVICE_KEYS.DATABASE)) as Database
      start(manager as ShardingManager, _configData.statsServer.port, db);
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

  await spawnShards(manager);

  // Initialize auxiliary services (top.gg, backups, stats server)
  await initializeAuxiliaryServices();

  await registerShutdownTask();
}

const initializeShard = async (): Promise<void> => {
  logger.trace(`Initializing shard process ${getShardId()}`, `${processState.role.toUpperCase()}`)
  await initializeShardProcess()
}

const initializeMain = async (): Promise<void> => {
  logger.trace("Initializing main process", `${processState.role.toUpperCase()}`)
  await initializeMainProcess()
}

const handleInitializationError = (err: unknown): void => {
  logger.error(`Initialization error: ${err instanceof Error ? err.message : String(err)}`)
  if (err instanceof Error && err.stack) {
    logger.debug(`Initialization stack trace: ${err.stack}`)
  }

  _isStartupInProgress = false

  const timeoutId = setTimeout(() => {
    if (!_isShardProcess) {
      handleMainShutdown("initialization failure").catch((e) =>
        logger.error(`Error during shutdown after initialization failure: ${e}`)
      )
    } else {
      exitProcess(1, "Shard initialization failed")
    }
  }, 2000)

  _initTimeouts.add(timeoutId)
};

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

// Set up entry point logic
function setupEntryPoint(): void {
  if (require.main === module && !_hasInitialized) {
    _hasInitialized = true;
    trackInitState("Entry point execution");

    // Increase max listeners to avoid warnings for the process object
    process.setMaxListeners(20);

    // Log startup at info level but only once
    if (!_applicationStartupComplete && !_messagesSuppressed) {
      logger.trace(
        `Thread-Watcher starting (${isMainProcess() ? "main" : "shard"} process ${process.pid})`,
        "STARTUP"
      );
      _messagesSuppressed = true;
    }

    // Let initializeShutdownHandlers from shutdown.ts handle the error setup
    // instead of duplicating the logic here
    initializeShutdownHandlers(isShard());

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

        // Use exitProcess from shutdown.ts for consistent behavior
        exitProcess(
          1,
          `Initialization failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    } catch (err) {
      logger.error(`Critical error during initialization setup: ${err}`);
      exitProcess(1, `Critical startup error: ${String(err)}`);
    }
  }
}

// Call the setupEntryPoint function
setupEntryPoint();

// Export necessary objects and functions
export { _configData as config }

/**
 * Get the initialized ShardManager instance
 * @returns The ShardManager instance or undefined if not initialized
 */
export function getShardManager(): ShardingManager | undefined {
  return _shardManager
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
export { serviceRegistry } from "./services"

