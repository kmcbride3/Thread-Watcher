import { Client, Collection, Events, GatewayDispatchEvents, GatewayIntentBits } from "discord.js";
import { logger } from "./index";
import { Command } from "./interfaces/command";
import { SERVICE_KEYS, serviceRegistry } from "./services";
import { handleApiError } from "./utilities/apiErrorHandler";
import loadCommands from "./utilities/loadCommands";
import loadEvents from "./utilities/loadEvents";
import { isShard } from "./utilities/processState";
import { safeObjectAccess } from "./utilities/securityUtils";
import { isThreadChannel } from "./utilities/threadUtils";

// Store commands in a private collection that's accessed through a getter
const _commands = new Collection<string, Command>();

// Provide a safe read-only accessor for commands
export function getCommands(): Collection<string, Command> {
  return _commands;
}

// Track initialization state in a way that actually gets used
let isInitialized = false;

/**
 * Initialize the Discord bot
 */
export async function initBot(discordClient: Client | null): Promise<Client> {
  // Prevent multiple initializations
  if (isInitialized) {
    return serviceRegistry.get(SERVICE_KEYS.CLIENT);
  }

  // Get all required services from the registry
  // Note: These service retrievals validate that all dependencies are available
  // before proceeding with initialization. If any service is missing, the get()
  // method will throw an error, preventing partial initialization.
  const logger = serviceRegistry.get(SERVICE_KEYS.LOGGER);
  const configData = serviceRegistry.get(SERVICE_KEYS.CONFIG);
  const _db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
  const _shutdownManager = serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER);

  // Use provided client or create a new one
  const actualClient =
    discordClient ??
    new Client({
      intents: [GatewayIntentBits.Guilds],
    });

  // Initialize user settings - required for thread monitoring
  const _settingsInstance = serviceRegistry.get(SERVICE_KEYS.USER_SETTINGS);

  // Check if thread manager is available
  if (!serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
    logger.warn("Thread manager service not available during initialization - monitoring disabled");

    // Set up a retry check to log when thread manager becomes available
    setTimeout(() => {
      if (serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
        logger.info("Thread manager service now available after delay");
      } else {
        logger.warn("Thread manager still not available after delay");
      }
    }, 3000);
  } else {
    logger.debug("Thread manager service is available for thread monitoring");
  }

  // Register client in the service registry
  serviceRegistry.register(SERVICE_KEYS.CLIENT, actualClient);

  // Configure client event handlers
  actualClient.on(Events.ShardError, (error: Error) => {
    logger.error(`Shard Error: ${error.message}`, `SHARD ${actualClient.shard?.ids[0]}`);
    if (error.stack) logger.error(error.stack);
  });

  actualClient.on(Events.Error, (error: Error) => {
    logger.error(`Client Error: ${error.message}`, `SHARD ${actualClient.shard?.ids[0]}`);
    if (error.stack) logger.error(error.stack);
  });

  actualClient.on(Events.Debug, (info: string) => {
    if (Number(configData.logLevel) >= 4) {
      logger.trace(`Discord Debug: ${info}`, `SHARD ${actualClient.shard?.ids[0]}`);
    }
  });

  // Handle ready event
  actualClient.on(Events.ClientReady, async () => {
    // Use the actual client reference
    const shardId = actualClient.shard?.ids[0] ?? 0;
    if (!actualClient.user) {
      logger.error("Client ready but no user available", `SHARD ${shardId}`);
      return;
    }

    logger.done(`Logged in as ${actualClient.user.tag}!`, `SHARD ${shardId}`);

    try {
      // Initialize thread monitoring if thread manager is available
      if (serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
        const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);

        // Set the REST client for the thread manager
        threadManager.setRestClient(actualClient.rest);

        // Now that client is ready, we can synchronize thread data with database
        logger.info(`Loading thread data from database...`, `SHARD ${shardId}`);
        await threadManager.loadThreadsFromDatabase();
        logger.done(`Thread data loaded successfully`, `SHARD ${shardId}`);

        // Start thread monitoring
        logger.info(`Starting thread monitoring for shard ${shardId}`, `SHARD ${shardId}`);
        threadManager.startThreadMonitoring(shardId);
      } else {
        logger.error(
          `Thread manager service not available, monitoring not started`,
          `SHARD ${shardId}`
        );
      }
    } catch (err) {
      logger.error(`Failed to initialize thread monitoring: ${err}`, `SHARD ${shardId}`);
    }

    // Initialize commands
    try {
      logger.trace("Loading commands...", `SHARD ${shardId}`);
      await loadCommands();
      logger.debug("Commands loaded", `SHARD ${shardId}`);
    } catch (loadCommandsErr) {
      logger.error(`Error loading commands: ${loadCommandsErr}`, `SHARD ${shardId}`);
    }

    // Load event handlers
    try {
      logger.trace("Loading event handlers...", `SHARD ${shardId}`);
      await loadEvents(actualClient, logger);
      logger.debug("Event handlers loaded", `SHARD ${shardId}`);
    } catch (loadEventsErr) {
      logger.error(`Error loading event handlers: ${loadEventsErr}`, `SHARD ${shardId}`);
    }

    // Mark as initialized
    isInitialized = true;
  });

  // Handle shard disconnect
  actualClient.on(Events.ShardDisconnect, (_closeEvent, shardId) => {
    logger.warn(`Disconnected from Discord`, `SHARD ${shardId}`);

    // Pause thread monitoring when disconnected
    if (serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
      threadManager.pauseThreadMonitoring(shardId);
    }
  });

  // Handle reconnect
  actualClient.on(Events.ShardReconnecting, (shardId) => {
    logger.info(`Reconnecting to Discord...`, `SHARD ${shardId}`);
  });

  // Handle resume
  actualClient.on(Events.ShardResume, (shardId) => {
    logger.done(`Connection resumed`, `SHARD ${shardId}`);

    // Resume thread monitoring when connection is restored
    if (serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
      threadManager.startThreadMonitoring(shardId);
    }
  });

  // Handle raw gateway events for direct control
  actualClient.on(Events.Raw, async (packet) => {
    try {
      if (!packet) return;

      // Handle thread creation events
      if (packet.t === GatewayDispatchEvents.ThreadCreate) {
        await handleThreadCreate(packet.d).catch((err) =>
          logger.warn(
            `Error in thread creation handler: ${err}`,
            `THREAD ${safeObjectAccess(packet.d, "id", ["id"]) || "unknown"}`
          )
        );
      }

      // Handle thread update events
      if (packet.t === GatewayDispatchEvents.ThreadUpdate) {
        await handleThreadUpdate(packet.d).catch((err) =>
          logger.warn(
            `Error in thread update handler: ${err}`,
            `THREAD ${safeObjectAccess(packet.d, "id", ["id"]) || "unknown"}`
          )
        );
      }

      // Handle thread deletion events
      if (packet.t === GatewayDispatchEvents.ThreadDelete) {
        await handleThreadDelete(packet.d).catch((err) =>
          logger.warn(
            `Error in thread deletion handler: ${err}`,
            `THREAD ${safeObjectAccess(packet.d, "id", ["id"]) || "unknown"}`
          )
        );
      }
    } catch (err) {
      const threadId = safeObjectAccess(packet, "d.id", ["d", "id"]) || "unknown";
      logger.error(`Error handling raw gateway event: ${err}`, `THREAD ${threadId}`);
    }
  });

  // Standard Discord.js event handler - no need to send custom message
  actualClient.once(Events.ShardReady, (shardId, unavailableGuilds) => {
    logger.trace(
      `Ready with ${unavailableGuilds?.size || 0} unavailable guilds`,
      `SHARD ${shardId}`
    );

    // Send ready signal to main process if we're a shard
    if (isShard() && process.send) {
      logger.debug(`Sent ready signal to main process`, `SHARD ${shardId}`);
      process.send({ type: "SHARD_READY", id: shardId });
    }
  });

  // Connect to Discord if not already connected
  if (!actualClient.isReady()) {
    await actualClient.login(configData.tokens.discord);
  }

  return actualClient;
}

// Define interfaces for raw gateway event data
interface RawThreadCreateData {
  id: string;
  guild_id: string;
  parent_id?: string;
  name?: string;
  [key: string]: unknown;
}

interface RawThreadUpdateData {
  id: string;
  guild_id: string;
  thread_metadata?: {
    archived?: boolean;
    auto_archive_duration?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RawThreadDeleteData {
  id: string;
  guild_id: string;
  [key: string]: unknown;
}

/**
 * Handle thread creation events directly from the gateway
 */
async function handleThreadCreate(data: RawThreadCreateData): Promise<void> {
  const threadId = safeObjectAccess<RawThreadCreateData, "id", string>(data, "id", ["id"]);
  const guildId = safeObjectAccess<RawThreadCreateData, "guild_id", string>(data, "guild_id", [
    "guild_id",
  ]);

  if (!threadId || !guildId) {
    logger.debug("Invalid thread create data received");
    return;
  }

  try {
    // Use the service registry to get the client
    const actualClient = serviceRegistry.get(SERVICE_KEYS.CLIENT);
    const channel = await actualClient.channels.fetch(threadId);
    if (!channel || !isThreadChannel(channel)) return;

    // Check if the thread's parent channel is being watched
    // This would indicate we should auto-watch this thread
    const parentId = channel.parentId;
    if (!parentId) return;

    // Get database and settings instances from the registry
    const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
    const settingsInstance = serviceRegistry.get(SERVICE_KEYS.USER_SETTINGS);

    // Check if the thread's parent channel is being watched directly using the database
    const isParentWatched = await settingsInstance.isChannelWatched(parentId, guildId);

    if (isParentWatched) {
      // Auto-watch this thread since its parent is watched
      logger.info(
        `Auto-watching new thread ${channel.name} (${threadId}) in watched channel`,
        `THREAD ${threadId}`
      );
      const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);

      // Calculate the due archive time
      const dueArchive = Date.now() + (channel.autoArchiveDuration || 1440) * 60 * 1000;

      // Add to database directly using the db service
      await db.insertThread(threadId, dueArchive, guildId);

      // Watch thread in memory
      threadManager.watchThread(channel, guildId);

      // Ensure we join the thread
      if (!channel.joined && channel.joinable) {
        await channel
          .join()
          .catch((err) =>
            logger.warn(`Failed to join new thread ${threadId}: ${err}`, `THREAD ${threadId}`)
          );
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    handleApiError(
      null,
      () => {
        throw err;
      },
      2, // retries
      1000 // delay
    );
  }
}

/**
 * Handle thread updates directly from the gateway
 */
async function handleThreadUpdate(data: RawThreadUpdateData): Promise<void> {
  const threadId = safeObjectAccess<RawThreadUpdateData, "id", string>(data, "id", ["id"]);

  if (!threadId) {
    logger.debug("Invalid thread update data received");
    return;
  }

  // Check if this thread is being watched using database directly
  const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
  const threads = await db.getThreads(safeObjectAccess(data, "guild_id", ["guild_id"]) || "");
  const isWatched = threads.some((thread) => thread.id === threadId && thread.watching);

  if (!isWatched) return; // Not our concern

  // Access thread metadata using safeObjectAccess
  const archived =
    safeObjectAccess(data, "thread_metadata.archived", ["thread_metadata", "archived"]) || false;

  if (archived) {
    try {
      const actualClient = serviceRegistry.get(SERVICE_KEYS.CLIENT);
      const channel = await actualClient.channels.fetch(threadId).catch(() => null);

      if (channel && isThreadChannel(channel)) {
        logger.info(`Unarchiving watched thread ${threadId}`, `THREAD ${threadId}`);

        // First ensure we're in the thread
        if (!channel.joined && channel.joinable) {
          await channel
            .join()
            .catch((err) =>
              logger.warn(
                `Failed to join thread ${threadId} before unarchiving: ${err}`,
                `THREAD ${threadId}`
              )
            );
        }

        // Attempt to unarchive it
        await channel.setArchived(false).catch((err) => {
          logger.warn(`Failed to unarchive thread ${threadId}: ${err}`, `THREAD ${threadId}`);
        });

        // Update any due archive time directly in the database
        if (channel.autoArchiveDuration) {
          const dueArchive = Date.now() + channel.autoArchiveDuration * 60 * 1000;
          await db.updateDueArchive(threadId, dueArchive);
          logger.debug(`Updated thread ${threadId} due archive timestamp`, `THREAD ${threadId}`);
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      handleApiError(
        null,
        () => {
          throw err;
        },
        2, // retries
        1000 // delay
      );
    }
  }
}

/**
 * Handle thread deletion events directly from the gateway
 */
async function handleThreadDelete(data: RawThreadDeleteData): Promise<void> {
  const threadId = safeObjectAccess<RawThreadDeleteData, "id", string>(data, "id", ["id"]);

  if (!threadId) {
    logger.debug("Invalid thread delete data received");
    return;
  }

  try {
    // Use database directly to check if thread was being watched
    const db = serviceRegistry.get(SERVICE_KEYS.DATABASE);
    const threads = await db.getAllWatchedThreads();
    const watchedThread = threads.find((thread) => thread.id === threadId);

    if (!watchedThread || !watchedThread.watching) return; // Not our concern

    // Thread was deleted, remove it from database
    logger.info(
      `Watched thread ${threadId} was deleted, removing from database`,
      `THREAD ${threadId}`
    );

    await db.deleteThread(threadId).catch((err) => {
      logger.warn(
        `Failed to remove deleted thread ${threadId} from database: ${err}`,
        `THREAD ${threadId}`
      );
    });

    // Also update the thread manager
    const threadManager = serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
    threadManager.unwatchThread(threadId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    handleApiError(
      null,
      () => {
        throw err;
      },
      2, // retries
      1000 // delay
    );
  }
}

// Store commands in the local collection
export function setCommand(name: string, command: Command): void {
  _commands.set(name, command);
}
