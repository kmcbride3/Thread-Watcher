import { Collection, RateLimitData, REST, ShardingManager } from "discord.js"
import { SERVICE_KEYS, serviceRegistry } from "../services"
import { safeLog } from "./logger"
import { messageRouter } from "./messageRouter"
import { isShard } from "./processState"

// Track event listener registration to prevent duplicates
let messageListenerRegistered = false
// Singleton instance reference
let _instance: RateLimitManager | null = null;

/**
 * Define message structure types for IPC communication
 */
interface BaseRateLimitMessage {
  type: string;
}

interface RateLimitUpdateMessage extends BaseRateLimitMessage {
  type: "RATE_LIMIT_UPDATE";
  route: string;
  reset: number;
  remaining: number;
}

interface GlobalRateLimitMessage extends BaseRateLimitMessage {
  type: "GLOBAL_RATE_LIMIT";
  reset: number;
}

interface RateLimitRequestMessage extends BaseRateLimitMessage {
  type: "RATE_LIMIT_REQUEST";
  route: string;
  requestId: string;
}

interface RateLimitPermissionMessage extends BaseRateLimitMessage {
  type: "RATE_LIMIT_PERMISSION";
  requestId: string;
}

// Union type for all possible rate limit messages
type RateLimitMessage =
  | RateLimitUpdateMessage
  | GlobalRateLimitMessage
  | RateLimitRequestMessage
  | RateLimitPermissionMessage;

/**
 * Rate limit manager for coordinating API requests across shards
 * This implementation uses IPC to synchronize between processes,
 * which is the most practical approach for Node.js's process model
 */
export class RateLimitManager {
  private rateLimits = new Collection<string, { reset: number; remaining: number }>();
  private globalRateLimit: number | null = null;
  private rest: REST | null = null;
  private cleanupInterval: NodeJS.Timeout | undefined;

  // Track if we're in a shard for IPC handling
  private isShardProcess = isShard();

  // Store active request handlers to allow proper cleanup
  private activeRequestHandlers = new Set<string>();

  /**
   * Why we need IPC for rate limit management:
   *
   * 1. Process Isolation: Each shard is a separate Node.js process with its own memory
   * 2. Reference Sharing: Cannot share object references between processes
   * 3. State Synchronization: Need to keep rate limit state in sync across all processes
   * 4. Performance: Direct IPC is more efficient than external databases for this use case
   */
  constructor() {
    // Note: TypeScript constructors cannot return different instances
    // Instead, we'll check in the factory function and not initialize twice

    // In shards, register with messageRouter instead of direct process.on()
    if (this.isShardProcess && !messageListenerRegistered) {
      messageListenerRegistered = true

      // Use messageRouter instead of direct process.on()
      messageRouter.registerHandler(
        (message) => {
    // Type guard for message
          if (!RateLimitManager.isRateLimitMessage(message)) return;

          // Now TypeScript knows message is a RateLimitMessage
          switch (message.type) {
            case "RATE_LIMIT_UPDATE":
              this.handleRateLimitUpdate(message.route, message.reset, message.remaining)
              break
            case "GLOBAL_RATE_LIMIT":
              this.globalRateLimit = message.reset
              break;
            default:
              // No need to log unhandled types as they should be filtered by the type guard
              break;
          }
        },
        {
          id: "rate-limit-handler",
          name: "Rate Limit Message Handler",
          filter: (message) => RateLimitManager.isRateLimitMessage(message),
          priority: 5, // Medium priority
        }
      )

      safeLog("debug", "Registered rate limit IPC message handler");
    }

    // Use safeLog instead of logger to avoid circular dependency
    if (this.isShardProcess) {
      safeLog("debug", "Rate limit manager initialized in shard mode (using IPC sync)");
    } else {
      safeLog("debug", "Rate limit manager initialized in main process mode (coordinating shards)");
    }

    // Set up cleanup interval to remove expired rate limits
    this.cleanupInterval = setInterval(() => this.cleanupExpiredRateLimits(), 60000) // Run every minute
  }

  /**
   * Clean up any temporary event listeners when this instance is no longer needed
   */
  public cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }

    // Remove message handler if registered
    if (messageListenerRegistered) {
      messageRouter.removeHandler("rate-limit-handler")
      messageListenerRegistered = false
    }

    // Remove any active request handlers that weren't properly cleaned up
    for (const handlerId of this.activeRequestHandlers) {
      messageRouter.removeHandler(handlerId)
    }
    this.activeRequestHandlers.clear()

    // Log cleanup for debugging
    safeLog("debug", "Cleaned up RateLimitManager event handlers", "RATE_LIMIT");
  }

  /**
   * Type guard to check if a message is a valid rate limit message
   */
  private static isRateLimitMessage(message: unknown): message is RateLimitMessage {
    return (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      typeof message.type === "string" &&
      (message.type === "RATE_LIMIT_UPDATE" ||
        message.type === "GLOBAL_RATE_LIMIT" ||
        message.type === "RATE_LIMIT_REQUEST" ||
        message.type === "RATE_LIMIT_PERMISSION")
    );
  }

  /**
   * Handle rate limit information from the API
   */
  public handleRateLimit(info: RateLimitData): void {
    const route = RateLimitManager.normalizeRoute(info.route);
    const resetTime = Date.now() + info.timeToReset;

    // Calculate remaining as 0 since we've hit a rate limit
    // RateLimitData doesn't include a remaining property
    const remaining = 0;

    if (info.global) {
      safeLog("warn", `Hit global rate limit on ${route}, reset in ${info.timeToReset}ms`);
      this.globalRateLimit = resetTime;

      // If in main process, broadcast to all shards
      if (!this.isShardProcess) {
        const globalLimitMessage: GlobalRateLimitMessage = {
          type: "GLOBAL_RATE_LIMIT",
          reset: resetTime,
        };
        void RateLimitManager.broadcastToShards(globalLimitMessage);
      }
      // If in shard, inform main process
      else if (this.isShardProcess && process.send) {
        const globalLimitMessage: GlobalRateLimitMessage = {
          type: "GLOBAL_RATE_LIMIT",
          reset: resetTime,
        };
        process.send(globalLimitMessage);
      }
    } else {
      safeLog("debug", `Rate limited on ${route}, reset in ${info.timeToReset}ms`);
      this.rateLimits.set(route, {
        reset: resetTime,
        remaining,
      });

      // If in shard, inform main process
      if (this.isShardProcess && process.send) {
        const updateMessage: RateLimitUpdateMessage = {
          type: "RATE_LIMIT_UPDATE",
          route,
          reset: resetTime,
          remaining,
        };
        process.send(updateMessage);
      }
      // If in main process, broadcast to all shards
      else if (!this.isShardProcess) {
        const updateMessage: RateLimitUpdateMessage = {
          type: "RATE_LIMIT_UPDATE",
          route,
          reset: resetTime,
          remaining,
        };
        void RateLimitManager.broadcastToShards(updateMessage);
      }
    }
  }

  /**
   * Check if a route is currently rate limited
   */
  public isRateLimited(route: string): boolean {
    // Check global rate limit first
    if (this.globalRateLimit && Date.now() < this.globalRateLimit) {
      return true;
    }

    // Then check specific route
    const normalizedRoute = RateLimitManager.normalizeRoute(route);
    const limit = this.rateLimits.get(normalizedRoute);

    if (!limit) return false;

    // If we have remaining requests, not rate limited
    if (limit.remaining > 0) return false;

    // If reset time has passed, not rate limited
    if (Date.now() > limit.reset) {
      this.rateLimits.delete(normalizedRoute);
      return false;
    }

    // Otherwise, we are rate limited
    return true;
  }

  /**
   * Get the timestamp when a rate limit will reset
   */
  public getRateLimitedUntil(route: string): number | null {
    // Check global rate limit first
    if (this.globalRateLimit && Date.now() < this.globalRateLimit) {
      return this.globalRateLimit;
    }

    // Then check specific route
    const normalizedRoute = RateLimitManager.normalizeRoute(route);
    const limit = this.rateLimits.get(normalizedRoute);

    if (!limit || Date.now() > limit.reset) {
      return null;
    }

    return limit.reset;
  }

  /**
   * Wait until rate limit is clear before continuing
   */
  public async waitForRateLimit(route: string): Promise<void> {
    // In shards, request permission from main process
    if (this.isShardProcess && process.send) {
      await this.requestPermissionFromMain(route);
    }

    const resetTime = this.getRateLimitedUntil(route);
    if (resetTime) {
      const delay = resetTime - Date.now();
      if (delay > 0) {
        safeLog("debug", `Waiting ${delay}ms for rate limit on ${route}`);
        await new Promise((resolve) => setTimeout(resolve, delay + 100)); // Add 100ms buffer
      }
    }
  }

  /**
   * Request permission to make API call from main process (shard only)
   */
  private async requestPermissionFromMain(route: string): Promise<void> {
    if (!process.send) return;

    await new Promise<void>((resolve) => {
      const requestId = `${route}-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`;

      // Use messageRouter instead of direct process.on()
      const handlerId = messageRouter.registerHandler(
        (message) => {
          // Type guard for permission message
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "RATE_LIMIT_PERMISSION" &&
            "requestId" in message &&
            message.requestId === requestId
          ) {
            messageRouter.removeHandler(handlerId)
            this.activeRequestHandlers.delete(handlerId)
            resolve()
          }
        },
        {
          id: `rate-limit-request-${requestId}`,
          name: `Rate Limit Request Handler (${requestId})`,
          filter: (message) => {
            if (typeof message !== "object" || message === null) return false
            const msg = message as Record<string, unknown>
            return (
              "type" in msg &&
              msg.type === "RATE_LIMIT_PERMISSION" &&
              "requestId" in msg &&
              msg.requestId === requestId
            )
          },
          priority: 10, // Higher priority for request handlers
        }
      );

      // Add to tracking for cleanup
      this.activeRequestHandlers.add(handlerId);

      // Send the request with proper typing
      const requestMessage: RateLimitRequestMessage = {
        type: "RATE_LIMIT_REQUEST",
        route: RateLimitManager.normalizeRoute(route),
        requestId,
      };

      try {
        if (process.send) {
          process.send(requestMessage)
        }
      } catch (err) {
        // Handle send failure gracefully
        safeLog("debug", `Failed to send rate limit request message: ${err}`)
      }

      // Set a timeout in case main process doesn't respond
      setTimeout(() => {
        messageRouter.removeHandler(`rate-limit-request-${requestId}`)
        this.activeRequestHandlers.delete(handlerId);
        resolve(); // Continue anyway after timeout
      }, 1000);
    });
  }

  /**
   * Normalize API route for consistent rate limit tracking
   */
  private static normalizeRoute(route: string): string {
    // Replace ID patterns with :id to group similar routes
    if (!route) return "unknown";
    return route.replace(/\/\d{17,19}/g, "/:id");
  }

  /**
   * Broadcast rate limit information to all shards (main process only)
   */
  private static async broadcastToShards(message: RateLimitMessage): Promise<void> {
  // This method should only be called from the main process
    try {
      // Get the shard manager with safer accessor pattern
      const manager = (await serviceRegistry.tryGet(SERVICE_KEYS.SHARD_MANAGER)) as
        ShardingManager | undefined;

      if (!manager || !manager.shards || manager.shards.size === 0) {
        // No broadcasting needed if no shardManager or single shard
        return;
      }

      manager.shards.forEach((shard) => {
        try {
          if (shard.process && !shard.process.killed) {
            shard.send(message).catch((): void => {
              // Silently fail if we can't send to a shard
            });
          }
        } catch {
          // Ignore errors sending to specific shards
        }
      });
    } catch (err) {
      // Log error but don't crash the application
      safeLog(
        "debug",
        `Failed to broadcast rate limit: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Handle rate limit update from main process or another shard
   */
  private handleRateLimitUpdate(route: string, reset: number, remaining: number): void {
    this.rateLimits.set(route, { reset, remaining });
  }

  /**
   * Remove expired rate limits from the collection
   */
  private cleanupExpiredRateLimits(): void {
    const now = Date.now()
    let expiredCount = 0

    // Clear expired global rate limit
    if (this.globalRateLimit && this.globalRateLimit < now) {
      this.globalRateLimit = null
      expiredCount++
    }

    // Clear specific route rate limits
    for (const [route, limit] of this.rateLimits.entries()) {
      if (limit.reset < now) {
        this.rateLimits.delete(route)
        expiredCount++
      }
    }

    if (expiredCount > 0) {
      safeLog("trace", `Cleaned up ${expiredCount} expired rate limits`)
    }
  }

  /**
   * Set the REST client to monitor for rate limits
   */
  public setRest(rest: REST): void {
    if (this.rest) return;

    this.rest = rest;

    // Set REST options
    this.rest.options.globalRequestsPerSecond = 48;
    this.rest.options.invalidRequestWarningInterval = 10;

    try {
      this.rest.options.rejectOnRateLimit = (data) => {
        safeLog("warn", `[REST] Rejecting request due to rate limit: ${JSON.stringify(data)}`)
        return true
      };
    } catch (err) {
      safeLog("warn", `Failed to set rejectOnRateLimit: ${err}`)
    }
  }

  /**
   * Update rate limit information from response headers
   * @param route API route that was accessed
   * @param headers HTTP headers from the response
   */
  public updateFromHeaders(route: string, headers: Record<string, string>): void {
    if (!route || !headers) return

    try {
      // Extract rate limit information from headers
      const remaining = parseInt(headers["x-ratelimit-remaining"] || "1", 10)
      const reset = parseInt(headers["x-ratelimit-reset"] || "0", 10) * 1000
      const global = headers["x-ratelimit-global"] === "true";

      // If there's reset-after, use it for more precise timing (in seconds)
      const resetAfter = parseFloat(headers["x-ratelimit-reset-after"] || "0") * 1000
      const resetTime = resetAfter ? Date.now() + resetAfter : reset;

      // If we're hitting limits (0 remaining), update rate limit tracking
      if (remaining <= 0 && resetTime > Date.now()) {
        const normalizedRoute = RateLimitManager.normalizeRoute(route);

        if (global) {
          safeLog("warn", `Global rate limit from headers on ${route}, reset in ${resetAfter}ms`)
          this.globalRateLimit = resetTime;

          // Synchronize across shards
          if (!this.isShardProcess) {
            void RateLimitManager.broadcastToShards({
              type: "GLOBAL_RATE_LIMIT",
              reset: resetTime,
            })
          } else if (this.isShardProcess && process.send) {
            process.send({
              type: "GLOBAL_RATE_LIMIT",
              reset: resetTime,
            })
          }
        } else {
          safeLog(
            "debug",
            `Rate limit from headers on ${route}, reset in ${resetAfter}ms, remaining: ${remaining}`
          )
          this.rateLimits.set(normalizedRoute, {
            reset: resetTime,
            remaining,
          });

          // Synchronize across shards
          if (this.isShardProcess && process.send) {
            process.send({
              type: "RATE_LIMIT_UPDATE",
              route: normalizedRoute,
              reset: resetTime,
              remaining,
            })
          } else if (!this.isShardProcess) {
            void RateLimitManager.broadcastToShards({
              type: "RATE_LIMIT_UPDATE",
              route: normalizedRoute,
              reset: resetTime,
              remaining,
            })
          }
        }
      }
    } catch (err) {
      safeLog("debug", `Failed to update rate limit from headers: ${err}`);
    }
  }
}

/**
 * Get the singleton instance of RateLimitManager
 * This ensures we always use the same instance throughout the application
 */
export function getRateLimitManager(): RateLimitManager {
  if (!_instance) {
    safeLog("debug", "Creating RateLimitManager singleton instance", "RATE_LIMIT")
    _instance = new RateLimitManager()
  } else {
    safeLog("trace", "Using existing RateLimitManager instance", "RATE_LIMIT")
  }
  return _instance
}

// Create and export singleton instance
export const rateLimitManager = getRateLimitManager()

// Register the rate limit manager with the service registry
// This ensures it can be accessed by other parts of the application
try {
  if (
    SERVICE_KEYS &&
    SERVICE_KEYS.RATE_LIMIT_MANAGER &&
    !serviceRegistry.isAvailable(SERVICE_KEYS.RATE_LIMIT_MANAGER)
  ) {
    serviceRegistry.register(SERVICE_KEYS.RATE_LIMIT_MANAGER, rateLimitManager)
    safeLog("debug", "Rate limit manager registered with service registry", "RATE_LIMIT")
  }
} catch (error) {
  // If registration fails due to circular dependencies, it will be handled by the recovery mechanism
  safeLog(
    "debug",
    `Rate limit manager registration deferred: ${error instanceof Error ? error.message : String(error)}`,
    "RATE_LIMIT"
  )
}

// Make sure we clean up when the process exits
process.once("exit", () => {
  if (_instance) {
    _instance.cleanup()
    _instance = null
  }
})
