import {
  Client,
  ClientEvents,
  Collection,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
} from "discord.js"
import { Command } from "./interfaces/command"
import { SERVICE_KEYS, serviceRegistry } from "./services"
import { handleApiError } from "./utilities/apiErrorHandler"
import { EventManager } from "./utilities/eventManager"
import loadCommands from "./utilities/loadCommands"
import loadEvents from "./utilities/loadEvents"
import { logger } from "./utilities/logger"
import { isShard } from "./utilities/processState"
import { safeObjectAccess } from "./utilities/securityUtils"
import { ThreadManager } from "./utilities/threadManager"
import { dueArchiveTimestamp, isThreadChannel } from "./utilities/threadUtils"

// Store commands in a private collection that's accessed through a getter
const _commands = new Collection<string, Command>();

// Provide a safe read-only accessor for commands
export function getCommands(): Collection<string, Command> {
  return _commands;
}

// Track initialization state in a way that actually gets used
let isInitialized = false;

// Track registered event handlers for proper cleanup
const clientEventHandlers = new Map<string, string>()

// Track whether we've already sent a ready signal to prevent duplicates
let hasReportedReady = false

/**
 * Clean up any event handlers registered for a client
 * @param client The client to clean up handlers for
 */
function cleanupClientEventHandlers(client: Client): void {
  if (!client) return

  // Clean up each registered handler
  for (const [handlerId, event] of clientEventHandlers) {
    try {
      EventManager.removeHandler(client, event, handlerId)
      logger.trace(`Removed event handler ${handlerId}`, "BOT")
    } catch (err) {
      logger.debug(`Error removing handler ${handlerId}: ${err}`, "BOT")
    }
  }

  // Clear the set once all handlers are removed
  clientEventHandlers.clear()
  logger.debug("Cleaned up all client event handlers", "BOT")
}

/**
 * Initialize the Discord bot
 */
export async function initBot(discordClient: Client | null): Promise<Client> {
  // If already initialized, clean up before reinitializing
  if (isInitialized && discordClient) {
    logger.debug("Bot already initialized, cleaning up before reinitializing")
    cleanupClientEventHandlers(discordClient);
  }

  // Get all required services from the registry
  await serviceRegistry.get(SERVICE_KEYS.LOGGER) // Validate logger is available
  const configData = await serviceRegistry.get(SERVICE_KEYS.CONFIG)
  await serviceRegistry.get(SERVICE_KEYS.DATABASE) // Validate database is available
  await serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER) // Validate shutdown manager is available

  // Use provided client or create a new one
  const actualClient =
    discordClient ??
    new Client({
      intents: [GatewayIntentBits.Guilds],
    });

  // Increase max listeners for the client to handle many events
  actualClient.setMaxListeners(20);

  // Initialize user settings - required for thread monitoring
  await serviceRegistry.get(SERVICE_KEYS.USER_SETTINGS) // Validate user settings is available

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

  // Register event handlers with consistent naming pattern for later cleanup
  function registerHandler<K extends keyof ClientEvents>(
    event: K,
    handlerName: string,
    handler: (...args: ClientEvents[K]) => void
  ): void {
    const handlerId = `client-${handlerName}`
    // Cast to any as a temporary fix for the type issue between ClientEvents and EventHandler
    // EventHandler expects (...args: unknown[]) => void
    EventManager.addHandler(actualClient, event, handlerId, (...args: unknown[]) =>
      handler(...(args as ClientEvents[K]))
    )
    clientEventHandlers.set(handlerId, event)
  }

  // Configure client event handlers using EventManager and track them for cleanup
  registerHandler(Events.ShardError, "shard-error", (error: Error) => {
    logger.error(`Shard Error: ${error.message}`, `SHARD ${actualClient.shard?.ids[0]}`);
    if (error.stack) logger.error(error.stack);
  });

  registerHandler(Events.Error, "error", (error: Error) => {
    logger.error(`Client Error: ${error.message}`, `SHARD ${actualClient.shard?.ids[0]}`);
    if (error.stack) logger.error(error.stack);
  });

  registerHandler(Events.Debug, "debug", (info: string) => {
    if (Number(configData.logLevel) >= 4) {
      logger.trace(`Discord Debug: ${info}`, `SHARD ${actualClient.shard?.ids[0]}`);
    }
  });

  // Handle ready event
  registerHandler(Events.ClientReady, "ready", async () => {
    const shardId = actualClient.shard?.ids[0] ?? 0;
    if (!actualClient.user) {
      logger.error("Client ready but no user available", `SHARD ${shardId}`);
      return;
    }

    logger.done(`Logged in as ${actualClient.user.tag}!`, `SHARD ${shardId}`);

    try {
      if (serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
        const threadManager = await serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);

        threadManager.setRestClient(actualClient.rest);

        logger.info("Loading thread data from database...", `SHARD ${shardId}`);
        await threadManager.loadThreadsFromDatabase();
        logger.done("Thread data loaded successfully", `SHARD ${shardId}`);

        logger.info(`Initializing servers with watched content...`, `SHARD ${shardId}`)
        await initializeWatchedServers(threadManager, actualClient, shardId)
        logger.debug(`Server initialization complete`, `SHARD ${shardId}`)

        logger.info(`Starting thread monitoring for Shard ${shardId}`, `SHARD ${shardId}`)
        await threadManager.startThreadMonitoring(shardId);
      } else {
        logger.error(
          "Thread manager service not available, monitoring not started",
          `SHARD ${shardId}`
        );
      }
    } catch (err) {
      logger.error(`Failed to initialize thread monitoring: ${err}`, `SHARD ${shardId}`);
    }

    try {
      logger.trace("Loading commands...", `SHARD ${shardId}`);
      await loadCommands();
      logger.debug("Commands loaded", `SHARD ${shardId}`);
    } catch (loadCommandsErr) {
      logger.error(`Error loading commands: ${loadCommandsErr}`, `SHARD ${shardId}`);
    }

    isInitialized = true;
  });

  // Handle shard disconnect
  registerHandler(Events.ShardDisconnect, "disconnect", async (_closeEvent, shardId) => {
    logger.warn("Disconnected from Discord", `SHARD ${shardId}`);

    if (serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      const threadManager = await serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
      threadManager.pauseThreadMonitoring(shardId);
    }
  });

  // Handle reconnect
  registerHandler(Events.ShardReconnecting, "reconnecting", (shardId) => {
    logger.info("Reconnecting to Discord...", `SHARD ${shardId}`);
  });

  // Handle resume
  registerHandler(Events.ShardResume, "resume", async (shardId) => {
    logger.done("Connection resumed", `SHARD ${shardId}`);

    if (serviceRegistry.isAvailable(SERVICE_KEYS.THREAD_MANAGER)) {
      const threadManager = await serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER)
      await threadManager.startThreadMonitoring(shardId).catch((err: unknown) => {
        logger.error(`Failed to restart thread monitoring: ${String(err)}`, `SHARD ${shardId}`)
      });
    }
  });

  // Handle raw gateway events for direct control
  const rawHandlerId = "client-raw-gateway"
  EventManager.addHandler(actualClient, "raw", rawHandlerId, async (...args: unknown[]) => {
    const packet = args[0] as { t?: GatewayDispatchEvents; d?: unknown } | undefined;
    try {
      if (!packet) return;

      if (packet.t === GatewayDispatchEvents.ThreadCreate) {
        await handleThreadCreate(packet.d as RawThreadCreateData).catch((err) =>
          logger.warn(
            `Error in thread creation handler: ${err}`,
            `THREAD ${safeObjectAccess(packet.d as object, "id", ["id"]) || "unknown"}`
          )
        );
      }

      if (packet.t === GatewayDispatchEvents.ThreadUpdate) {
        await handleThreadUpdate(packet.d as RawThreadUpdateData).catch((err) =>
          logger.warn(
            `Error in thread update handler: ${err}`,
            `THREAD ${safeObjectAccess(packet.d as object, "id", ["id"]) || "unknown"}`
          )
        );
      }

      if (packet.t === GatewayDispatchEvents.ThreadDelete) {
        await handleThreadDelete(packet.d as RawThreadDeleteData).catch((err) =>
          logger.warn(
            `Error in thread deletion handler: ${err}`,
            `THREAD ${safeObjectAccess(packet.d as object, "id", ["id"]) || "unknown"}`
          )
        );
      }
    } catch (err) {
      const threadId = safeObjectAccess(packet as object, "d.id", ["d", "id"]) || "unknown";
      logger.error(`Error handling raw gateway event: ${err}`, `THREAD ${threadId}`);
    }
  });
  clientEventHandlers.set(rawHandlerId, "raw");

  // Standard Discord.js event handler - no need to send custom message
  registerHandler(Events.ShardReady, "shard-ready", (shardId, unavailableGuilds) => {
    logger.trace(
      `Ready with ${unavailableGuilds?.size || 0} unavailable guilds`,
      `SHARD ${shardId}`
    );

    // Only send ready signal once per shard process
    if (isShard() && process.send && !hasReportedReady) {
      hasReportedReady = true // Set flag to prevent duplicate signals
      logger.debug("Sent ready signal to main process", `SHARD ${shardId}`);
      process.send({ type: "SHARD_READY", id: shardId });
    }
  });

  // Register cleanup function with shutdown manager
  try {
    const shutdownManager = await serviceRegistry.get(SERVICE_KEYS.SHUTDOWN_MANAGER)
    shutdownManager.registerCleanupTask(
      async () => {
        cleanupClientEventHandlers(actualClient)
        logger.debug("Client event handlers cleaned up during shutdown")
      },
      {
        name: "Client_Event_Handlers_Cleanup",
        priority: 2, // Higher priority to ensure it runs early
        timeout: 2000,
      }
    )
  } catch (err) {
    logger.warn(`Failed to register event handler cleanup task: ${err}`)
  }

  if (!actualClient.isReady()) {
    await actualClient.login(configData.tokens.discord);
  }

  await loadEvents(actualClient, logger);

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
    const actualClient = await serviceRegistry.get(SERVICE_KEYS.CLIENT);
    const channel = await actualClient.channels.fetch(threadId);
    if (!channel || !isThreadChannel(channel)) return;

    const parentId = channel.parentId;
    if (!parentId) return;

    const db = await serviceRegistry.get(SERVICE_KEYS.DATABASE)
    const settingsInstance = await serviceRegistry.get(SERVICE_KEYS.USER_SETTINGS);

    const isParentWatched = await settingsInstance.isChannelWatched(parentId, guildId);

    if (isParentWatched) {
      logger.info(
        `Auto-watching new thread ${channel.name} (${threadId}) in watched channel`,
        `THREAD ${threadId}`
      );
      const threadManager = await serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);

      const dueArchive = dueArchiveTimestamp(channel.autoArchiveDuration || 1440);

      await db.insertThread(threadId, dueArchive, guildId);

      threadManager.watchThread(channel, guildId);

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
      2,
      1000
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

  const db = await serviceRegistry.get(SERVICE_KEYS.DATABASE);
  const threads = await db.getThreads(safeObjectAccess(data, "guild_id", ["guild_id"]) || "");
  const isWatched = threads.some((thread) => thread.id === threadId && thread.watching);

  if (!isWatched) return;

  const archived =
    safeObjectAccess(data, "thread_metadata.archived", ["thread_metadata", "archived"]) || false;

  if (archived) {
    try {
      const actualClient = await serviceRegistry.get(SERVICE_KEYS.CLIENT);
      const channel = await actualClient.channels.fetch(threadId).catch(() => null);

      if (channel && isThreadChannel(channel)) {
        logger.info(`Unarchiving watched thread ${threadId}`, `THREAD ${threadId}`);

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

        await channel.setArchived(false).catch((err) => {
          logger.warn(`Failed to unarchive thread ${threadId}: ${err}`, `THREAD ${threadId}`);
        });

        if (channel.autoArchiveDuration) {
          const dueArchive = dueArchiveTimestamp(channel.autoArchiveDuration);
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
        2,
        1000
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
    const db = await serviceRegistry.get(SERVICE_KEYS.DATABASE);
    const threads = await db.getAllWatchedThreads();
    const watchedThread = threads.find((thread) => thread.id === threadId);

    if (!watchedThread || !watchedThread.watching) return;

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
    const threadManager = await serviceRegistry.get(SERVICE_KEYS.THREAD_MANAGER);
    threadManager.unwatchThread(threadId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    handleApiError(
      null,
      () => {
        throw err;
      },
      2,
      1000
    );
  }
}

/**
 * Store a command in the commands collection
 */
export function setCommand(name: string, command: Command): void {
  _commands.set(name, command);
}

/**
 * Initialize all servers with watched content
 */
async function initializeWatchedServers(
  threadManager: ThreadManager,
  client: Client,
  shardId: number
): Promise<void> {
  try {
    // First check if database service is available
    if (!serviceRegistry.isAvailable(SERVICE_KEYS.DATABASE)) {
      logger.warn("Database not available for initializing watched servers", `SHARD ${shardId}`)
      return
    }

    const db = await serviceRegistry.get(SERVICE_KEYS.DATABASE)

    // Get all servers with watched threads first
    logger.debug(`Fetching watched content information from database`, `SHARD ${shardId}`)

    // Start by getting all watched threads
    const watchedThreads = await db.getAllWatchedThreads()

    // Extract unique server IDs from watched threads
    const serverIds = new Set<string>()

    watchedThreads.forEach((thread) => {
      if (thread.server) serverIds.add(thread.server)
    })

    // For each server, check if it has watched channels
    // This replaces the non-existent getAllWatchedChannels() method
    const watchedChannelsPromises = Array.from(serverIds).map(async (serverId) => {
      try {
        const channels = await db.getChannels(serverId)
        return channels.map((channel) => ({ ...channel, server: serverId }))
      } catch (err) {
        logger.warn(`Error fetching channels for Server ${serverId}: ${err}`, `SHARD ${shardId}`)
        return []
      }
    })

    // Wait for all channel queries to complete
    const watchedChannelsArrays = await Promise.all(watchedChannelsPromises)

    // Flatten the arrays into a single array of watched channels
    const watchedChannels = watchedChannelsArrays.flat()

    // Add any servers that have watched channels to our serverIds set
    watchedChannels.forEach((channel) => {
      if (channel.server) serverIds.add(channel.server)
    })

    if (serverIds.size === 0) {
      logger.debug(`No servers with watched content found`, `SHARD ${shardId}`)
      return
    }

    logger.info(
      `Found ${serverIds.size} servers with watched content to initialize`,
      `SHARD ${shardId}`
    )

    // Only initialize servers available to this shard; avoid REST fetches for guild membership
    let processedCount = 0
    for (const serverId of serverIds) {
      try {
        const guild = client.guilds.cache.get(serverId)
        if (guild) {
          processedCount++
          logger.debug(
            `Initializing watched content for Server ${guild.name} (${serverId})`,
            `SHARD ${shardId}`
          )
          await threadManager.checkThreadsForServer(serverId)
        } else {
          logger.debug(
            `Server ${serverId} not available to this shard, skipping initialization`,
            `SHARD ${shardId}`
          )
        }
      } catch (serverError) {
        logger.warn(`Error initializing Server ${serverId}: ${serverError}`, `SHARD ${shardId}`)
      }
    }

    if (processedCount > 0) {
      logger.info(`Initialized ${processedCount} servers with watched content`, `SHARD ${shardId}`)
    } else {
      logger.debug(`No servers required initialization on this shard`, `SHARD ${shardId}`)
    }
  } catch (error) {
    logger.error(`Failed to initialize watched servers: ${error}`, `SHARD ${shardId}`)
  }
}
