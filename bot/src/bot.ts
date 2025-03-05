import {
  Client,
  GatewayIntentBits,
  Partials,
  Options,
  ShardingManager,
  Collection,
  Events,
} from "discord.js";
import { Command } from "./interfaces/command";
import { getRestClient } from "./utilities/discordRest";
import loadEvents from "./utilities/loadEvents";
import loadCommands from "./utilities/loadCommands";
import { getDatabase } from "./utilities/database/DatabaseManager";
import UserSettings from "./utilities/userSettings";
import { ConfigFile } from "./utilities/cnf/index";
import { Log76 } from "./utilities/logger";
import { LogLevel } from "log75";
import { threadManager } from "./utilities/threadManager";
import { WatchedThread } from "./interfaces/thread";

// Create and export the client with optimized intents
const client = new Client({
  // Only request intents we actually need
  intents: [
    GatewayIntentBits.Guilds, // For basic guild data and thread events
    GatewayIntentBits.GuildMessages, // For monitoring new messages in threads
  ],
  // Include partials we need to handle
  partials: [
    Partials.Channel, // For handling thread channels properly
    Partials.Message, // For handling messages in threads
  ],
  // Optimize cache management
  makeCache: Options.cacheWithLimits({
    // Focused caching for thread management
    MessageManager: 10, // Only cache minimal messages
    PresenceManager: 0, // Don't cache presence at all
    UserManager: {
      maxSize: 100, // Minimal user caching
      keepOverLimit: (user): boolean => user.id === client.user?.id, // Always keep the bot user
    },
    GuildMemberManager: 0, // Don't cache members by default
    ThreadManager: {
      maxSize: 500, // Cache more threads since that's our focus
    },
  }),
  // Add sweep filters separately
  sweepers: {
    threads: {
      filter: () => {
        return (thread) => {
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

// Exportable globals for sharing state.
let settings: UserSettings;
let commands = new Collection<string, Command>();
let restClient: ReturnType<typeof getRestClient>;

// Ensure initBot is only called once.
let botInitialized = false;

// All initialization logic is contained within initBot.
export async function initBot(
  manager: ShardingManager | null, // allow null
  logger: Log76,
  config: ConfigFile,
  database: ReturnType<typeof getDatabase>
): Promise<void> {
  logger.trace(`initBot called in process ${process.pid}`);

  if (botInitialized) {
    logger.trace("botInitialized is true, returning from initBot.");
    return;
  }

  if (logger.logLevel === LogLevel.Trace) {
    logger.trace(`botInitialized is false, proceeding with initBot. Process ${process.pid}`);
  } else {
    logger.debug(`botInitialized is false, proceeding with initBot. Process ${process.pid}`);
  }
  botInitialized = true;

  try {
    // Initialize REST client first for proper API interactions
    restClient = getRestClient();
    logger.trace("REST client initialized");

    // Make the REST client available to threadManager
    threadManager.setRestClient(restClient);

    // Initialize database and settings.
    const db = database;
    if (!db) {
      if (LogLevel[logger.logLevel] === "Trace") {
        logger.trace("initBot error: Database not provided");
      } else {
        logger.error("[SHARD] Database not provided");
      }
      throw new Error("Database not initialized");
    }

    logger.debug("[SHARD] Creating tables in database");
    db.createTables();
    settings = new UserSettings(db);

    // Load commands and events
    logger.debug("[SHARD] About to load events.");

    await loadEvents(client, logger);

    logger.debug("[SHARD] About to load commands.");
    try {
      commands = await loadCommands();
      logger.done("[SHARD] Commands loaded successfully");
    } catch (error) {
      if (LogLevel[logger.logLevel] === "Trace") {
        logger.trace(
          `Failed to load commands: ${error instanceof Error ? error.message : String(error)}`
        );
      } else {
        logger.trace(
          `Failed to load commands: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      process.exit(1);
    }

    // Setup proper client event handlers
    client.on(Events.Error, (error) => {
      logger.error(`Client error: ${error}`);
    });

    client.on(Events.Debug, (message) => {
      logger.trace(`Client debug: ${message}`);
    });

    client.on(Events.Warn, (message) => {
      logger.warn(`Client warning: ${message}`);
    });

    client.on(Events.ThreadCreate, (thread) => {
      if (thread.guildId) {
        logger.trace(`Thread created: ${thread.name} (${thread.id})`);
      }
    });

    client.on(Events.ThreadDelete, (thread) => {
      threadManager.unwatchThread(thread.id);
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

    async function handleShardShutdown(code: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;

      if (LogLevel[logger.logLevel] === "Trace") {
        logger.trace(`Shard shutdown started: ${code}`);
      } else {
        logger.info(`[SHARD] Shutdown initiated due to: ${code}`);
      }

      const shutdownTimeout: NodeJS.Timeout = setTimeout(() => {
        logger.error("[SHARD] Shutdown process taking too long, forcing exit...");
        process.exit(1);
      }, 10000);

      try {
        logger.debug("[SHARD] Destroying client...");
        await client.destroy();
        logger.debug("[SHARD] Client destroyed.");

        clearTimeout(shutdownTimeout);
        logger.done("[SHARD] Shard shut down successfully.");

        if (typeof process.send === "function") {
          logger.debug("[SHARD] Sending KILL_SHARD message to parent");
          process.send({ op: "KILL_SHARD" } as { op: string });
        } else {
          logger.debug("[SHARD] process.send not available in this context.");
        }

        logger.trace("Shard process exit");
        process.removeAllListeners();
        process.exit(0);
      } catch (err: unknown) {
        logger.error(`Error during shutdown: ${err}`);
        if (err instanceof Error && err.stack) logger.error(err.stack);
        clearTimeout(shutdownTimeout);
        process.removeAllListeners();
        process.exit(1);
      }
    }

    // Log before starting client.login.
    logger.debug(
      `[SHARD] Entering client.login phase with token ${config.tokens.discord ? "provided" : "missing"}`
    );
    if (!config.tokens.discord) {
      if (logger.logLevel === LogLevel.Trace) {
        logger.trace("Discord token is missing or invalid");
      } else {
        logger.error("Discord token is missing or invalid");
      }
      process.exit(1);
    }

    try {
      if (LogLevel[logger.logLevel] === "Trace") {
        logger.trace("Attempting Discord login");
        await client.login(config.tokens.discord);
        logger.trace("Discord login successful");
      } else {
        logger.debug("Attempting to login to Discord");
        await client.login(config.tokens.discord);
        logger.debug("Bot logged in successfully.");
      }

      // Initialize thread monitoring after successful login
      threadManager.startThreadMonitoring();
    } catch (err) {
      let errorMsg = "Unknown error";

      try {
        errorMsg = err instanceof Error ? err.message : String(err);
        if (typeof err === "object" && err !== null) {
          errorMsg = JSON.stringify(err);
        }
      } catch {
        /* fallback to basic error message */
      }

      if (LogLevel[logger.logLevel] === "Trace") {
        logger.trace(`Discord login failed: ${errorMsg}`);
      } else {
        logger.error(`client.login failed with error: ${errorMsg}`);
      }

      if (errorMsg.includes("Not enough sessions remaining")) {
        logger.warn(`Could not authorise bot. ${errorMsg}`);
        try {
          const match = /resets at ([\d-]+T[\d:.]+Z)/.exec(errorMsg);
          if (match) {
            const resetTime = new Date(match[1]).getTime();
            const now = Date.now();
            const waitMs = resetTime > now ? resetTime - now : 0;

            // Wait for session limit to reset
            logger.info(`Waiting ${waitMs}ms for session limit to reset`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));

            logger.info("Retrying login after waiting for session reset...");
            await client.login(config.tokens.discord);
            logger.done("Login successful after session reset wait.");
          } else {
            logger.error("Could not parse session reset time from error.");
            await handleShardShutdown("login failure");
          }
        } catch (retryError) {
          logger.error(`Error retrying login: ${retryError}`);
          await handleShardShutdown("login failure");
        }
      } else {
        await handleShardShutdown("login failure");
      }
    }

    // Safe process message handling
    if (typeof process.on === "function") {
      process.on("message", async (message) => {
        logger.debug(
          `[SHARD] Received process message: ${typeof message === "object" ? JSON.stringify(message) : message}`
        );

        if (message === "shutdown") {
          if (LogLevel[logger.logLevel] === "Trace") {
            logger.trace("Shard received shutdown message");
          } else {
            logger.debug("[SHARD] Received shutdown message, shutting down shard.");
          }
          await handleShardShutdown("received shutdown message");
        }
      });

      process.on("uncaughtException", async (err) => {
        logger.error(
          `[FATAL ERROR] shard ${client.shard?.ids} encountered a fatal error. (dump below)`
        );
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
  } catch (initError) {
    logger.trace(
      `Bot initialization failed: ${initError instanceof Error ? initError.message : String(initError)}`
    );
    logger.error(
      `Bot initialization failed: ${initError instanceof Error ? initError.message : String(initError)}`
    );
    if (initError instanceof Error && initError.stack) logger.error(initError.stack);
    process.exit(1);
  }
}

// Export client and all shared variables.
export { commands, client, restClient as rest, settings, threads, threadManager };
