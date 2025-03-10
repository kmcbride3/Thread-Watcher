import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
  ShardingManager,
  ThreadChannel,
} from "discord.js"
import { LogLevel } from "log75"
import { Command } from "./interfaces/command"
import { WatchedThread } from "./interfaces/thread"
import { ConfigFile } from "./utilities/cnf/index"
import { getDatabase } from "./utilities/database/DatabaseManager"
import { getRestClient } from "./utilities/discordRest"
import { ErrorSeverity, handleApiError } from "./utilities/errorSystem"
import loadCommands from "./utilities/loadCommands"
import loadEvents from "./utilities/loadEvents"
import { Log76 } from "./utilities/logger"
import { ShutdownManager } from "./utilities/shutdown"
import { threadManager } from "./utilities/threadManager"
import { isThreadChannel } from "./utilities/threadUtils"
import UserSettings from "./utilities/userSettings"

export type ThreadMap = Collection<string, WatchedThread>;

// Create and export the client with optimized intents
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message],
  // Optimize cache management
  makeCache: Options.cacheWithLimits({
    MessageManager: 10,
    PresenceManager: 0,
    UserManager: {
      maxSize: 100,
      keepOverLimit: (user): boolean => user.id === client.user?.id, // Always keep the bot user
    },
    GuildMemberManager: 0,
    ThreadManager: {
      maxSize: 500,
    },
  }),
  sweepers: {
    threads: {
      filter: () => {
        return (thread) => {
          if (!isThreadChannel(thread)) return true;
          const watched = threadManager.getWatchedThreads().has(thread.id);
          return !watched; // Only sweep if not watched
        };
      },
      interval: 3600, // Sweep every hour
    },
  },
  // This parameter is valid
  failIfNotExists: false,
  // REST options configuration
  rest: {
    version: "10",
    retries: 3,
    timeout: 15000,
  },
});

// For backward compatibility - will be migrated to threadManager
const threads = new Collection<string, WatchedThread>();

// Exportable globals for sharing state
const settings: { current: UserSettings | null } = { current: null };
const commands = new Collection<string, Command>();
const restClient: { current: ReturnType<typeof getRestClient> | null } = { current: null };
let shutdownManagerInstance: ShutdownManager | null = null;

let botInitialized = false;

/**
 * Initialize the bot with all dependencies
 */
export async function initBot(
  _manager: ShardingManager | null,
  loggerInstance: Log76,
  config: ConfigFile,
  database: ReturnType<typeof getDatabase>,
  shutdownMgr: ShutdownManager
): Promise<boolean> {
  const logger = loggerInstance;

  logger.trace(`initBot called in process ${process.pid}`);

  if (botInitialized) {
    logger.trace("botInitialized is true, returning from initBot.");
    return true;
  }

  logger.debug(`botInitialized is false, proceeding with initBot. Process ${process.pid}`);
  botInitialized = true;
  shutdownManagerInstance = shutdownMgr;

  try {
    const newRestClient = await handleApiError(
      "Failed to initialize REST client",
      async () => {
        const client = await getRestClient();
        logger.trace("REST client initialized");
        return client;
      },
      {
        context: "Bot Initialization - REST Client",
        reportAtSeverity: ErrorSeverity.HIGH,
        retries: 2,
        retryDelay: 1000,
      }
    );

    // Make REST client available to threadManager and update exports
    threadManager.setRestClient(newRestClient);
    restClient.current = newRestClient;

    // Initialize database and settings with error handling
    if (!database) {
      logger.error("[SHARD] Database not provided");
      throw new Error("Database not initialized");
    }

    await handleApiError(
      "Failed to initialize database tables",
      async () => {
        await database.createTables();
        return true;
      },
      {
        context: "Bot Initialization - Database Tables",
        reportAtSeverity: ErrorSeverity.CRITICAL,
        retries: 3,
        retryDelay: 2000,
      }
    );

    settings.current = new UserSettings(database);

    // Load commands and events with error handling
    logger.debug("[SHARD] About to load events.");

    await handleApiError(
      "Failed to load event handlers",
      async () => {
        return await loadEvents(client, logger);
      },
      {
        context: "Bot Initialization - Event Handlers",
        reportAtSeverity: ErrorSeverity.HIGH,
        retries: 2,
        retryDelay: 1000,
      }
    );

    try {
      const loadedCommands = await handleApiError(
        "Failed to load commands",
        async () => {
          return await loadCommands();
        },
        {
          context: "Bot Initialization - Commands",
          reportAtSeverity: ErrorSeverity.HIGH,
          retries: 2,
          retryDelay: 1000,
        }
      );

      commands.clear();
      for (const [key, command] of loadedCommands.entries()) {
        commands.set(key, command);
      }
      logger.debug("[SHARD] Commands loaded successfully");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load commands: ${errorMessage}`);
      shutdownMgr.shutdown(1, "Failed to load commands");
      return false;
    }

    // Setup client event handlers
    client.on(Events.Error, (error: Error) => {
      logger.error(`Client error: ${error.message}`);
    });

    client.on(Events.Debug, (message: string) => {
      logger.trace(`Client debug: ${message}`);
    });

    client.on(Events.Warn, (message: string) => {
      logger.warn(`Client warning: ${message}`);
    });

    client.on(Events.ThreadCreate, (thread: ThreadChannel) => {
      if (isThreadChannel(thread) && thread.guildId) {
        logger.trace(`Thread created: ${thread.name} (${thread.id})`);
      }
    });

    client.on(Events.ThreadDelete, (thread: ThreadChannel) => {
      if (isThreadChannel(thread)) {
        threadManager.unwatchThread(thread.id);
      }
    });

    client.on(Events.ShardReconnecting, () => {
      logger.warn("[SHARD] Reconnecting to Discord Gateway");
      threadManager.pauseThreadMonitoring();
    });

    client.on(Events.ShardResume, () => {
      logger.done("[SHARD] Reconnected to Discord Gateway");
      threadManager.startThreadMonitoring();
    });

    // Define handleShardShutdown to manage a graceful shutdown.
    let shuttingDown = false;

    const handleShardShutdown = async (code: string): Promise<void> => {
      if (shuttingDown) {
        logger.debug(`[SHARD] Ignoring duplicate shutdown trigger: ${code}`);
        return;
      }
      shuttingDown = true;

      if (LogLevel[logger.logLevel] === "Trace") {
        logger.trace(`Shard shutdown started: ${code}`);
      } else {
        logger.info(`[SHARD] Shutdown initiated due to: ${code}`);
      }

      const shutdownTimeout: NodeJS.Timeout = setTimeout(() => {
        logger.error("[SHARD] Shutdown process taking too long, forcing exit...");
        shutdownMgr.shutdown(1, "Shutdown timeout exceeded");
      }, 10000);

      try {
        logger.debug("[SHARD] Destroying client...");
        await client.destroy();
        logger.debug("[SHARD] Client destroyed.");

        clearTimeout(shutdownTimeout);
        logger.done("[SHARD] Shard shut down successfully.");

        if (typeof process.send === "function") {
          logger.debug("[SHARD] Sending KILL_SHARD message to parent");
          process.send({ op: "KILL_SHARD" });
        } else {
          shutdownMgr.shutdown(0, "Shard shutdown completed");
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Error during shutdown: ${errorMessage}`);
        if (err instanceof Error && err.stack) logger.error(err.stack);
        clearTimeout(shutdownTimeout);
        process.removeAllListeners();
        shutdownMgr.shutdown(1, "Error during shard shutdown");
      }
    };

    // Authenticate with Discord
    logger.debug(
      `[SHARD] Entering client.login phase with token ${config.tokens.discord ? "provided" : "missing"}`
    );

    if (!config.tokens.discord) {
      if (logger.logLevel === LogLevel.Trace) {
        logger.trace("Discord token is missing or invalid");
      } else {
        logger.error("Discord token is missing or invalid");
      }
      shutdownMgr.shutdown(1, "Missing Discord token");
      return false;
    }

    try {
      await handleApiError(
        "Discord login failed",
        async () => {
          if (LogLevel[logger.logLevel] === "Trace") {
            logger.trace("Attempting Discord login");
            await client.login(config.tokens.discord);
            logger.trace("Discord login successful");
          } else {
            logger.debug("Attempting to login to Discord");
            await client.login(config.tokens.discord);
            logger.debug("Bot logged in successfully.");
          }
          return true;
        },
        {
          context: "Bot Initialization - Discord Login",
          reportAtSeverity: ErrorSeverity.CRITICAL,
          retries: 1,
        }
      );
    } catch (err: unknown) {
      let errorMsg = "Unknown error";

      try {
        errorMsg = err instanceof Error ? err.message : String(err);
        if (typeof err === "object" && err !== null) {
          errorMsg = JSON.stringify(err);
        }
      } catch {
        /* fallback to basic error message */
      }

      if (errorMsg.includes("Not enough sessions remaining")) {
        logger.warn(`Could not authorize bot. ${errorMsg}`);
        try {
          const match = /resets at ([\d-]+T[\d:.]+Z)/.exec(errorMsg);
          if (match?.[1]) {
            const resetTime = new Date(match[1]).getTime();
            const now = Date.now();
            const waitMs = resetTime > now ? resetTime - now : 0;

            // Wait for session limit to reset
            logger.info(`Waiting ${waitMs}ms for session limit to reset`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));

            logger.info("Retrying login after waiting for session reset...");
            await client.login(config.tokens.discord);
            logger.done("Login successful after session reset wait.");
            return true;
          } else {
            logger.error("Could not parse session reset time from error.");
          }
        } catch (retryError) {
          logger.error(`Error retrying login: ${retryError}`);
          await handleShardShutdown("login failure");
        }
      } else {
        await handleShardShutdown("login failure");
      }

      await handleShardShutdown("login failure");
      return false;
    }

    // Add explicit ready event handler to notify ShardingManager
    client.once(Events.ClientReady, (readyClient) => {
      logger.done(`Bot ready as ${readyClient.user.tag}`);

      // Signal to parent process that the shard is ready - using Discord.js's expected format
      if (typeof process.send === "function") {
        try {
          // Send a single message containing both the Discord.js required format and our custom data
          process.send({
            _ready: true,
            id: client.shard?.ids[0] || 0,
            type: "SHARD_READY",
            botId: readyClient.user.id,
          });

          logger.debug("[SHARD] Sent ready signal to parent process");
        } catch (err) {
          logger.error(`Failed to send ready signal to parent: ${err}`);
        }
      }

      // Start thread monitoring with proper error handling
      handleApiError(
        "Failed to start thread monitoring",
        async () => {
          await threadManager.startThreadMonitoring();
          return true;
        },
        {
          context: "Thread Monitoring Startup (ClientReady)",
          reportAtSeverity: ErrorSeverity.HIGH,
          retries: 2,
          retryDelay: 1000,
        }
      ).catch((err) => {
        logger.error(`Thread monitoring failed to start: ${err}`);
      });
    });

    // Set up process event handlers
    if (typeof process.on === "function") {
      // Dedicated message handler for shutdown commands from parent
      const messageHandlers = new Map<string, (data?: unknown) => Promise<void>>();

      // Register the shutdown message handler
      messageHandlers.set("shutdown", async () => {
        logger.debug("[SHARD] Received shutdown message from parent");
        await handleShardShutdown("received shutdown message");
      });

      process.on("message", async (message) => {
        // Handle structured and simple string messages
        if (typeof message === "string") {
          const handler = messageHandlers.get(message);
          if (handler) {
            await handler();
          } else {
            logger.debug(`[SHARD] Received unhandled string message: ${message}`);
          }
        } else if (message && typeof message === "object") {
          const messageStr = JSON.stringify(message);
          logger.debug(`[SHARD] Received process message: ${messageStr}`);
          // Check for command in op field
          if ("op" in message && typeof message.op === "string") {
            const handler = messageHandlers.get(message.op);
            if (handler) {
              await handler(message);
            }
          }
        }
      });

      // Don't directly handle termination signals in shards - let the parent coordinate
      // Just log them for debugging purposes
      process.on("SIGINT", () => {
        logger.debug("[SHARD] Received SIGINT signal - waiting for parent coordination");
        // DO NOT initiate shutdown here
      });

      process.on("SIGTERM", () => {
        logger.debug("[SHARD] Received SIGTERM signal - waiting for parent coordination");
        // DO NOT initiate shutdown here
      });

      process.on("uncaughtException", async (err) => {
        const shardId = client.shard?.ids.join(",") || "unknown";
        logger.error(`[FATAL ERROR] shard ${shardId} encountered a fatal error.`);
        logger.error(err instanceof Error ? err.message : String(err));
        if (err instanceof Error && err.stack) logger.error(err.stack);

        if (LogLevel[logger.logLevel] === "Trace") {
          logger.trace(
            `Shard uncaught exception: ${err instanceof Error ? err.message : String(err)}`
          );
        } else {
          logger.debug("[SHARD] Calling handleShardShutdown due to uncaught exception");
        }

        await handleShardShutdown("uncaught exception");
      });
    }

    return true;
  } catch (initError: unknown) {
    const errorMessage = initError instanceof Error ? initError.message : String(initError);
    logger.error(`Bot initialization failed: ${errorMessage}`);
    if (initError instanceof Error && initError.stack) logger.error(initError.stack);

    if (initError instanceof Error) {
      const reportError = (await import("./utilities/errorReporter")).reportError;
      reportError(initError, "Bot Initialization Failure");
    }

    shutdownMgr.shutdown(1, "Bot initialization failed");
    return false;
  }
}

/**
 * Export API for other modules to use
 */
export { client, commands, threadManager, threads }

// Export with renamed identifiers
export const botRestClient = restClient.current;
export const botSettings = settings.current;
export const shutdownManager = shutdownManagerInstance;
