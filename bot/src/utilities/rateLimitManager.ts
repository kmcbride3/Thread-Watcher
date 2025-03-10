import { Collection, REST, RESTEvents, RateLimitData } from "discord.js";
import { logger } from "../index";
import { ErrorSeverity, handleApiError } from "./errorSystem";

/**
 * Information about a rate limit bucket
 */
interface BucketInfo {
  limited: boolean;
  limit: number;
  remaining: number;
  reset: number;
  route: string;
}

/**
 * Manages rate limits with a proper queue system to prevent hitting Discord's rate limits
 */
export class RateLimitManager {
  private static instance: RateLimitManager;
  private buckets = new Collection<string, BucketInfo>();
  private globalResetTime = 0;
  private rest: REST | null = null;
  private rateLimitedRoutes = new Collection<string, number>();

  // Private constructor for singleton
  private constructor() {
    // Schedule periodic cleanup
    setInterval(() => this.cleanupExpiredRateLimits(), 60000);
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): RateLimitManager {
    if (!RateLimitManager.instance) {
      RateLimitManager.instance = new RateLimitManager();
    }
    return RateLimitManager.instance;
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
      logger.warn(`[REST] Rejecting request due to rate limit: ${JSON.stringify(data)}`);
      return true;
    };

    // Register global rate limit handler
    this.rest.on(RESTEvents.RateLimited, (data: RateLimitData) => {
      this.handleRateLimit(data);
    });

    logger.debug("Rate limit manager initialized and monitoring REST client");
  }

  /**
   * Handle rate limit data from Discord.js client events
   */
  public handleRateLimit(data: RateLimitData): void {
    const { route, timeToReset, global } = data;
    const resetTime = Date.now() + timeToReset;

    this.rateLimitedRoutes.set(route, resetTime);

    logger.warn(
      `Rate limit hit for route ${route}. Retrying after ${new Date(resetTime).toISOString()}`
    );

    if (global) {
      this.globalResetTime = resetTime;
      logger.warn(
        `Global rate limit activated until ${new Date(this.globalResetTime).toISOString()}`
      );
    } else {
      this.buckets.set(route, {
        limited: true,
        limit: data.limit || 5,
        remaining: 0,
        reset: resetTime,
        route,
      });

      logger.debug(`Rate limit for bucket ${route} until ${new Date(resetTime).toISOString()}`);
    }
  }

  /**
   * Handle a 429 rate limit error
   */
  public async handle429(route: string, headers: Record<string, string>): Promise<void> {
    // Update rate limit information from headers
    this.updateFromHeaders(route, headers);

    const retryAfter = headers["retry-after"] ? parseInt(headers["retry-after"], 10) * 1000 : 5000;
    const isGlobal = headers["x-ratelimit-global"] === "true";

    // Use appropriate severity based on whether it's global or route-specific
    const severity = isGlobal ? ErrorSeverity.HIGH : ErrorSeverity.MEDIUM;

    logger.debug(`Received 429, waiting ${retryAfter}ms before retrying request to ${route}`);

    await handleApiError(
      `Rate limit exceeded for ${route}`,
      async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, retryAfter));
      },
      {
        retries: 0, // No additional retries needed as we're already waiting
        retryDelay: 0, // No additional delay needed
        reportAtSeverity: severity,
        context: `Rate Limit ${isGlobal ? "Global" : route}`,
      }
    );
  }

  /**
   * Check if a request should be allowed based on rate limits
   */
  public canMakeRequest(route: string): boolean {
    const now = Date.now();

    // Check global rate limit first
    if (this.globalResetTime > now) {
      return false;
    }

    // Check if this specific route is rate limited
    if (this.rateLimitedRoutes.has(route)) {
      const resetTime = this.rateLimitedRoutes.get(route);
      if (resetTime && resetTime > now) {
        return false;
      } else {
        // Clear expired rate limit
        this.rateLimitedRoutes.delete(route);
      }
    }

    // Check bucket-specific rate limit
    const bucket = this.buckets.get(route);
    if (!bucket) return true; // No limit known yet

    if (bucket.reset <= now) {
      // Reset has passed, update bucket
      bucket.limited = false;
      bucket.remaining = bucket.limit;
      return true;
    }

    if (bucket.limited || bucket.remaining <= 0) {
      return false;
    }

    // We have remaining requests, decrement and allow
    bucket.remaining--;
    return true;
  }

  /**
   * Wait until a request can be made
   */
  public async waitForRateLimit(route: string): Promise<void> {
    await handleApiError(
      null,
      async () => {
        while (!this.canMakeRequest(route)) {
          const waitTime = this.calculateWaitTime(route);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      },
      {
        retries: 2, // Allow up to 2 retries
        retryDelay: 1000, // 1 second initial delay between retries
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: `Rate Limit Wait (${route})`,
      }
    );
  }

  /**
   * Calculate the appropriate wait time for a route
   * @private
   */
  private calculateWaitTime(route: string): number {
    const now = Date.now();
    let waitTime = 100; // Default minimum wait

    // Check global limit
    if (this.globalResetTime > now) {
      waitTime = Math.max(waitTime, this.globalResetTime - now);
    }

    // Check route-specific limit
    const routeReset = this.rateLimitedRoutes.get(route);
    if (routeReset && routeReset > now) {
      waitTime = Math.max(waitTime, routeReset - now);
    }

    // Check bucket limit
    const bucket = this.buckets.get(route);
    if (bucket && bucket.reset > now) {
      waitTime = Math.max(waitTime, bucket.reset - now);
    }

    // Add small jitter to prevent thundering herd problems
    return waitTime + Math.random() * 200;
  }

  /**
   * Update bucket info based on response headers
   */
  public updateFromHeaders(route: string, headers: Record<string, string>): void {
    let bucket = this.buckets.get(route);
    if (!bucket) {
      bucket = {
        limited: false,
        limit: 5,
        remaining: 5,
        reset: 0,
        route,
      };
      this.buckets.set(route, bucket);
    }

    if (headers["x-ratelimit-limit"]) {
      bucket.limit = Number(headers["x-ratelimit-limit"]);
    }

    if (headers["x-ratelimit-remaining"]) {
      bucket.remaining = Number(headers["x-ratelimit-remaining"]);
    }

    if (headers["x-ratelimit-reset"]) {
      const resetTime = Number(headers["x-ratelimit-reset"]) * 1000;
      bucket.reset = resetTime;
    }

    if (headers["x-ratelimit-reset-after"]) {
      const resetAfter = Number(headers["x-ratelimit-reset-after"]) * 1000;
      bucket.reset = Date.now() + resetAfter;
    }

    if (headers["x-ratelimit-global"] === "true") {
      if (headers["retry-after"]) {
        const retryAfter = Number(headers["retry-after"]) * 1000;
        this.globalResetTime = Date.now() + retryAfter;
      }
    }

    // Update the rateLimitedRoutes collection for faster lookup
    if (bucket.limited || bucket.remaining <= 0) {
      this.rateLimitedRoutes.set(route, bucket.reset);
    }
  }

  /**
   * Get a bucket by route
   */
  public getBucket(route: string): BucketInfo | undefined {
    return this.buckets.get(route);
  }

  /**
   * Check if a route is rate limited
   */
  public isRateLimited(route: string): boolean {
    const resetTime = this.rateLimitedRoutes.get(route);
    if (resetTime && Date.now() < resetTime) return true;

    // Also check global rate limit
    return Date.now() < this.globalResetTime;
  }

  /**
   * Get the reset time for a rate-limited route
   */
  public getRateLimitedUntil(route: string): number | undefined {
    return this.rateLimitedRoutes.get(route);
  }

  /**
   * Clean up expired rate limits to prevent memory leaks
   * @private
   */
  private cleanupExpiredRateLimits(): void {
    const now = Date.now();

    const expiredRoutes = this.rateLimitedRoutes.sweep((resetTime) => resetTime <= now);

    // Count and reset expired buckets
    let resetBuckets = 0;
    this.buckets.forEach((bucket, _route) => {
      if (bucket.reset <= now && (bucket.limited || bucket.remaining < bucket.limit)) {
        // Reset the bucket
        bucket.limited = false;
        bucket.remaining = bucket.limit;
        resetBuckets++;
      }
    });

    // Log both cleanup operations if anything happened
    if (expiredRoutes > 0 || resetBuckets > 0) {
      logger.trace(
        `Rate limit cleanup: removed ${expiredRoutes} routes, reset ${resetBuckets} buckets`
      );
    }
  }

  /**
   * Get all currently rate-limited routes for debugging
   */
  public getCurrentRateLimits(): { route: string; reset: Date }[] {
    const now = Date.now();
    const limits: { route: string; reset: Date }[] = [];

    this.rateLimitedRoutes.forEach((resetTime, route) => {
      if (resetTime > now) {
        limits.push({
          route,
          reset: new Date(resetTime),
        });
      }
    });

    if (this.globalResetTime > now) {
      limits.push({
        route: "GLOBAL",
        reset: new Date(this.globalResetTime),
      });
    }

    return limits;
  }
}

// Export singleton instance
export const rateLimitManager = RateLimitManager.getInstance();
