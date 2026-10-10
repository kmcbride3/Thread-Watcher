import { Collection } from "discord.js";
import { safeLog } from "./logger"; // Import safeLog for early initialization

/**
 * Type for message handler functions
 */
type MessageHandler = (message: unknown) => void | Promise<void>;

/**
 * Interface for handler registration options
 */
interface HandlerOptions {
  /** Unique ID for the handler */
  id: string;
  /** Optional filter function to determine if this handler should process the message */
  filter?: (message: unknown) => boolean;
  /** Priority of the handler (higher numbers run first) */
  priority?: number;
  /** Friendly name for debugging */
  name?: string;
}

/**
 * Internal handler record with metadata
 */
interface RegisteredHandler {
  handler: MessageHandler;
  filter: (message: unknown) => boolean;
  priority: number;
  id: string;
  name: string;
}

/**
 * Centralized message router to prevent event listener leaks
 * by consolidating all process.on("message") handlers into one.
 */
export class MessageRouter {
  private handlers = new Collection<string, RegisteredHandler>();
  private sortedHandlers: RegisteredHandler[] = [];
  private isListening = false;
  private mainHandler: (message: unknown) => void;

  constructor() {
    // Create a single main handler that will route messages to all registered handlers
    this.mainHandler = this.routeMessage.bind(this);
  }

  /**
   * Register a message handler
   * @param handler Function to handle messages
   * @param options Configuration options
   * @returns Handler ID for later removal
   */
  registerHandler(handler: MessageHandler, options: HandlerOptions): string {
    const id = options.id;
    const name = options.name || `handler-${id}`;

    // Remove any existing handler with the same ID
    if (this.handlers.has(id)) {
      safeLog("debug", `Replacing existing message handler with ID: ${id}`, "ROUTER");
      this.handlers.delete(id);
    }

    // Create a new handler record
    const registeredHandler: RegisteredHandler = {
      handler,
      filter: options.filter || (() => true),
      priority: options.priority || 0,
      id,
      name,
    };

    // Add to our collection
    this.handlers.set(id, registeredHandler);
    this.refreshSortedHandlers();
    safeLog("trace", `Registered message handler: ${name} (ID: ${id})`, "ROUTER");

    // Make sure we're listening
    this.ensureListening();

    return id;
  }

  /**
   * Remove a registered handler
   * @param id Handler ID to remove
   * @returns true if removed, false if not found
   */
  removeHandler(id: string): boolean {
    const exists = this.handlers.has(id);
    if (exists) {
      this.handlers.delete(id);
      this.refreshSortedHandlers();
      safeLog("trace", `Removed message handler with ID: ${id}`, "ROUTER");

      // If no more handlers, remove the main listener
      if (this.handlers.size === 0) {
        this.stopListening();
      }
    }
    return exists;
  }

  /**
   * Remove all handlers and stop listening
   */
  removeAllHandlers(): void {
    const count = this.handlers.size;
    this.handlers.clear();
    this.sortedHandlers = [];
    this.stopListening();
    safeLog("debug", `Removed all ${count} message handlers`, "ROUTER");
  }

  /**
   * Get the number of registered handlers
   */
  get handlerCount(): number {
    return this.handlers.size;
  }

  /**
   * Main message routing function
   */
  private async routeMessage(message: unknown): Promise<void> {
    // Run handlers in order
    for (const handler of this.sortedHandlers) {
      try {
        // Check if this handler should process this message
        if (handler.filter(message)) {
          // Run the handler
          await Promise.resolve(handler.handler(message));
        }
      } catch (error) {
        safeLog(
          "error",
          `Error in message handler ${handler.name}: ${error instanceof Error ? error.message : String(error)}`,
          "ROUTER"
        );
      }
    }
  }

  private refreshSortedHandlers(): void {
    this.sortedHandlers = [...this.handlers.values()].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Ensure we're listening for messages
   */
  private ensureListening(): void {
    if (!this.isListening) {
      process.on("message", this.mainHandler);
      this.isListening = true;
      safeLog("debug", "Started listening for process messages", "ROUTER");
    }
  }

  /**
   * Stop listening for messages
   */
  private stopListening(): void {
    if (this.isListening) {
      process.off("message", this.mainHandler);
      this.isListening = false;
      safeLog("debug", "Stopped listening for process messages", "ROUTER");
    }
  }
}

// Export a singleton instance
export const messageRouter = new MessageRouter();

// Clean up on process exit
process.once("exit", () => {
  messageRouter.removeAllHandlers();
});
