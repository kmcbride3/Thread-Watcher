import { Collection } from "discord.js";
import { EventEmitter } from "events";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { safeLog } from "./logger";
import { messageRouter } from "./messageRouter";

const logger = {
  warn: (message: string): void => {
    void safeLog("warn", message);
  },
  trace: (message: string): void => {
    void safeLog("trace", message);
  },
  debug: (message: string, context?: string): void => {
    void safeLog("debug", message, context);
  },
};

/**
 * Type for event handler function
 */
type EventHandler = (...args: unknown[]) => void;

/**
 * Centralized event management to prevent duplicate listeners
 */
export class EventManager {
  private static handlers = new WeakMap<
    EventEmitter,
    Collection<string, Collection<string, EventHandler>>
  >();
  private static handlerCount = 0;
  private static processHandlers = new Collection<string, Collection<string, EventHandler>>();

  /**
   * Register a process event handler using messageRouter for "message" events
   * or direct process.on for other process events
   */
  static addProcessHandler(
    event: string,
    handlerId: string,
    handler: EventHandler,
    options: {
      priority?: number;
      filter?: (message: unknown) => boolean;
    } = {}
  ): void {
    // Validate inputs
    if (typeof event !== "string" || !event) {
      logger.warn("Invalid event name provided to addProcessHandler");
      return;
    }

    if (typeof handlerId !== "string" || !handlerId) {
      logger.warn(`Invalid handlerId provided for process event ${event}`);
      return;
    }

    if (typeof handler !== "function") {
      logger.warn(`Invalid handler function provided for ${event}:${handlerId}`);
      return;
    }

    // Remove existing handler with this ID if it exists
    this.removeProcessHandler(event, handlerId);

    // Initialize the collection for this event if it doesn't exist
    if (!this.processHandlers.has(event)) {
      this.processHandlers.set(event, new Collection<string, EventHandler>());
    }

    // Special handling for 'message' event - use messageRouter
    if (event === "message") {
      messageRouter.registerHandler(handler, {
        id: handlerId,
        name: `EventManager:${handlerId}`,
        priority: options.priority || 0,
        filter: options.filter,
      });

      // Store the handler ID for tracking
      const eventHandlers = this.processHandlers.get(event);
      if (eventHandlers) {
        eventHandlers.set(handlerId, handler);
      }
    } else {
      // For non-message events, register directly
      process.on(event, handler);

      // Store the handler ID for tracking
      const eventHandlers = this.processHandlers.get(event);
      if (eventHandlers) {
        eventHandlers.set(handlerId, handler);
      }
    }

    logger.trace(`Registered process handler for ${event}:${handlerId}`);
  }

  /**
   * Remove a process event handler
   */
  static removeProcessHandler(event: string, handlerId: string): void {
    // Validate inputs
    if (typeof event !== "string" || !event) {
      return;
    }

    if (typeof handlerId !== "string" || !handlerId) {
      return;
    }

    // Get the handlers for this event
    const eventHandlers = this.processHandlers.get(event);
    if (!eventHandlers || !eventHandlers.has(handlerId)) {
      return;
    }

    // Special handling for 'message' event - use messageRouter
    if (event === "message") {
      messageRouter.removeHandler(handlerId);
    } else {
      const handler = eventHandlers.get(handlerId);
      if (handler) {
        process.off(event, handler);
      }
    }

    // Remove from our tracking
    eventHandlers.delete(handlerId);
    logger.trace(`Removed process handler tracking for ${event}:${handlerId}`);
  }

  /**
   * Register an event handler with a unique ID
   */
  static addHandler(
    emitter: EventEmitter,
    event: string,
    handlerId: string,
    handler: EventHandler
  ): void {
    // Validate inputs
    if (!emitter || !(emitter instanceof EventEmitter)) {
      logger.warn(`Invalid EventEmitter provided to addHandler for ${event}`);
      return;
    }

    if (typeof event !== "string" || !event) {
      logger.warn("Invalid event name provided to addHandler");
      return;
    }

    if (typeof handlerId !== "string" || !handlerId) {
      logger.warn(`Invalid handlerId provided for event ${event}`);
      return;
    }

    if (typeof handler !== "function") {
      logger.warn(`Invalid handler function provided for ${event}:${handlerId}`);
      return;
    }

    // Remove existing handler with this ID if it exists
    this.removeHandler(emitter, event, handlerId);

    // Store the new handler and register it
    let emitterHandlers = this.handlers.get(emitter);
    if (!emitterHandlers) {
      emitterHandlers = new Collection();
      this.handlers.set(emitter, emitterHandlers);
    }

    let eventHandlers = emitterHandlers.get(event);
    if (!eventHandlers) {
      eventHandlers = new Collection();
      emitterHandlers.set(event, eventHandlers);
    }

    eventHandlers.set(handlerId, handler);
    this.handlerCount++;
    emitter.on(event, handler);
  }

  /**
   * Remove a specific handler by ID
   */
  static removeHandler(emitter: EventEmitter, event: string, handlerId: string): void {
    // Validate inputs
    if (!emitter || !(emitter instanceof EventEmitter)) {
      return;
    }

    if (typeof event !== "string" || !event) {
      return;
    }

    if (typeof handlerId !== "string" || !handlerId) {
      return;
    }

    const eventHandlers = this.handlers.get(emitter)?.get(event);
    if (!eventHandlers) {
      return;
    }

    const handler = eventHandlers.get(handlerId);
    if (handler) {
      emitter.off(event, handler);
      eventHandlers.delete(handlerId);
      this.handlerCount--;
    }
  }

  /**
   * Remove all handlers for an event
   */
  static clearEventHandlers(emitter: EventEmitter, event: string): void {
    // Validate inputs
    if (!emitter || !(emitter instanceof EventEmitter)) {
      return;
    }

    if (typeof event !== "string" || !event) {
      return;
    }

    const eventHandlers = this.handlers.get(emitter)?.get(event);
    if (!eventHandlers) {
      return;
    }

    // Remove only handlers registered by EventManager for this emitter and event
    for (const entry of eventHandlers.entries()) {
      if (Array.isArray(entry) && entry.length === 2) {
        const [_, handler] = entry;
        if (typeof handler === "function") {
          try {
            emitter.off(event, handler);
          } catch (err) {
            logger.debug(`Error removing event handler: ${err}`);
          }
        }
      }
    }

    // Clear the handlers after removing them
    this.handlerCount -= eventHandlers.size;
    eventHandlers.clear();
  }

  /**
   * Debug utility to log current handler counts
   */
  static logHandlerCounts(): void {
    logger.debug("Current event handler counts:");
    logger.debug(`Emitter-scoped handlers: ${this.handlerCount}`);
  }

  /**
   * Debug utility to log all handler counts including process handlers
   */
  static logAllHandlerCounts(): void {
    logger.debug("Current event handler counts:");

    // Emitter-scoped handlers cannot be enumerated from the WeakMap.
    logger.debug(`Emitter-scoped handlers: ${this.handlerCount}`);

    // Log process event handlers
    for (const [event, handlers] of this.processHandlers.entries()) {
      if (typeof event === "string" && handlers instanceof Collection) {
        logger.debug(`Process Event: ${event}, Handlers: ${handlers.size}`);
      }
    }

    // Log message router handlers count
    logger.debug(`Message Router Handlers: ${messageRouter.handlerCount}`);
  }
}

/**
 * Register the EventManager with the service registry
 */
export function registerEventManager(): void {
  try {
    if (
      SERVICE_KEYS &&
      SERVICE_KEYS.EVENT_MANAGER &&
      !serviceRegistry.isAvailable(SERVICE_KEYS.EVENT_MANAGER)
    ) {
      serviceRegistry.register(SERVICE_KEYS.EVENT_MANAGER, EventManager);
      logger.debug("EventManager registered with service registry", "EVENT_MANAGER");
    }
  } catch (error) {
    // If registration fails due to circular dependencies, it will be handled later
    logger.debug(
      `EventManager registration deferred: ${error instanceof Error ? error.message : String(error)}`,
      "EVENT_MANAGER"
    );
  }
}
