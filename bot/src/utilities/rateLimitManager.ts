import { Collection, RateLimitData, REST, ShardingManager } from "discord.js";
import { SERVICE_KEYS, serviceRegistry } from "../services";
import { safeLog } from "./logger";
import { isShard } from "./processState";

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

  // Track if we're in a shard for IPC handling
  private isShardProcess = isShard();

  /**
   * Why we need IPC for rate limit management:
   *
   * 1. Process Isolation: Each shard is a separate Node.js process with its own memory
   * 2. Reference Sharing: Cannot share object references between processes
   * 3. State Synchronization: Need to keep rate limit state in sync across all processes
   * 4. Performance: Direct IPC is more efficient than external databases for this use case
   */
  constructor() {
    // In shards, listen for rate limit updates from the main process
    if (this.isShardProcess) {
      process.on("message", (message: unknown) => {
        // Type guard for message
        if (!this.isRateLimitMessage(message)) return;

        // Now TypeScript knows message is a RateLimitMessage
        switch (message.type) {
          case "RATE_LIMIT_UPDATE":
            this.handleRateLimitUpdate(message.route, message.reset, message.remaining);
            break;
          case "GLOBAL_RATE_LIMIT":
            this.globalRateLimit = message.reset;
            break;
        }
      });
    }

    // Use safeLog instead of logger to avoid circular dependency
    if (this.isShardProcess) {
      safeLog("debug", "Rate limit manager initialized in shard mode (using IPC sync)");
    } else {
      safeLog("debug", "Rate limit manager initialized in main process mode (coordinating shards)");
    }
  }

  /**
   * Type guard to check if a message is a valid rate limit message
   */
  private isRateLimitMessage(message: unknown): message is RateLimitMessage {
    return (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      typeof message.type === "string"
    );
  }

  /**
   * Handle rate limit information from the API
   */
  handleRateLimit(info: RateLimitData): void {
    const route = this.normalizeRoute(info.route);
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
        this.broadcastToShards(globalLimitMessage);
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
        remaining: remaining,
      });

      // If in shard, inform main process
      if (this.isShardProcess && process.send) {
        const updateMessage: RateLimitUpdateMessage = {
          type: "RATE_LIMIT_UPDATE",
          route,
          reset: resetTime,
          remaining: remaining,
        };
        process.send(updateMessage);
      }
      // If in main process, broadcast to all shards
      else if (!this.isShardProcess) {
        const updateMessage: RateLimitUpdateMessage = {
          type: "RATE_LIMIT_UPDATE",
          route,
          reset: resetTime,
          remaining: remaining,
        };
        this.broadcastToShards(updateMessage);
      }
    }
  }

  /**
   * Check if a route is currently rate limited
   */
  isRateLimited(route: string): boolean {
    // Check global rate limit first
    if (this.globalRateLimit && Date.now() < this.globalRateLimit) {
      return true;
    }

    // Then check specific route
    const normalizedRoute = this.normalizeRoute(route);
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
  getRateLimitedUntil(route: string): number | null {
    // Check global rate limit first
    if (this.globalRateLimit && Date.now() < this.globalRateLimit) {
      return this.globalRateLimit;
    }

    // Then check specific route
    const normalizedRoute = this.normalizeRoute(route);
    const limit = this.rateLimits.get(normalizedRoute);

    if (!limit || Date.now() > limit.reset) {
      return null;
    }

    return limit.reset;
  }

  /**
   * Wait until rate limit is clear before continuing
   */
  async waitForRateLimit(route: string): Promise<void> {
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

    return new Promise<void>((resolve) => {
      const requestId = `${route}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

      // Set up listener for the response
      const responseHandler = (message: unknown) => {
        // Type guard for permission message
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "RATE_LIMIT_PERMISSION" &&
          "requestId" in message &&
          message.requestId === requestId
        ) {
          process.off("message", responseHandler);
          resolve();
        }
      };

      process.on("message", responseHandler);

      // Send the request with proper typing
      const requestMessage: RateLimitRequestMessage = {
        type: "RATE_LIMIT_REQUEST",
        route: this.normalizeRoute(route),
        requestId,
      };
      if (process.send) {
        process.send(requestMessage);
      }

      // Set a timeout in case main process doesn't respond
      setTimeout(() => {
        process.off("message", responseHandler);
        resolve(); // Continue anyway after timeout
      }, 1000);
    });
  }

  /**
   * Normalize API route for consistent rate limit tracking
   */
  private normalizeRoute(route: string): string {
    // Replace ID patterns with :id to group similar routes
    return route.replace(/\/\d{17,19}/g, "/:id");
  }

  /**
   * Broadcast rate limit information to all shards (main process only)
   */
  private broadcastToShards(message: RateLimitMessage): void {
    try {
      // Get the shard manager with safer accessor pattern
      const manager = serviceRegistry.tryGet(SERVICE_KEYS.SHARD_MANAGER) as
        | ShardingManager
        | undefined;

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
   * Set the REST client to monitor for rate limits
   */
  public setRest(rest: REST): void {
    if (this.rest) return;

    this.rest = rest;

    // Set REST options
    this.rest.options.globalRequestsPerSecond = 48;
    this.rest.options.invalidRequestWarningInterval = 10;
    this.rest.options.rejectOnRateLimit = (data) => {
      safeLog("warn", `[REST] Rejecting request due to rate limit: ${JSON.stringify(data)}`);
      return true;
    };
  }

  /**
   * Update rate limit information from response headers
   * @param route API route that was accessed
   * @param headers HTTP headers from the response
   */
  updateFromHeaders(route: string, headers: Record<string, string>): void {
    // Extract rate limit information from headers
    const remaining = parseInt(headers["x-ratelimit-remaining"] || "1", 10);
    const reset = parseInt(headers["x-ratelimit-reset"] || "0", 10) * 1000;
    const global = headers["x-ratelimit-global"] === "true";

    // If there's reset-after, use it for more precise timing (in seconds)
    const resetAfter = parseFloat(headers["x-ratelimit-reset-after"] || "0") * 1000;
    const resetTime = resetAfter ? Date.now() + resetAfter : reset;

    // If we're hitting limits (0 remaining), update rate limit tracking
    if (remaining <= 0 && resetTime > Date.now()) {
      const normalizedRoute = this.normalizeRoute(route);

      if (global) {
        safeLog("warn", `Global rate limit from headers on ${route}, reset in ${resetAfter}ms`);
        this.globalRateLimit = resetTime;

        // Synchronize across shards
        if (!this.isShardProcess) {
          this.broadcastToShards({
            type: "GLOBAL_RATE_LIMIT",
            reset: resetTime,
          });
        } else if (this.isShardProcess && process.send) {
          process.send({
            type: "GLOBAL_RATE_LIMIT",
            reset: resetTime,
          });
        }
      } else {
        safeLog(
          "debug",
          `Rate limit from headers on ${route}, reset in ${resetAfter}ms, remaining: ${remaining}`
        );
        this.rateLimits.set(normalizedRoute, {
          reset: resetTime,
          remaining: remaining,
        });

        // Synchronize across shards
        if (this.isShardProcess && process.send) {
          process.send({
            type: "RATE_LIMIT_UPDATE",
            route: normalizedRoute,
            reset: resetTime,
            remaining: remaining,
          });
        } else if (!this.isShardProcess) {
          this.broadcastToShards({
            type: "RATE_LIMIT_UPDATE",
            route: normalizedRoute,
            reset: resetTime,
            remaining: remaining,
          });
        }
      }
    }
  }
}

// Create and export singleton instance
export const rateLimitManager = new RateLimitManager();
