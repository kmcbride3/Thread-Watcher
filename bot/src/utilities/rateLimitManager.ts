import { REST, RESTEvents, RateLimitData, Collection } from "discord.js";
import { logger } from "../index";

/**
 * Information about a rate limit bucket
 */
interface BucketInfo {
  limited: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * Global rate limit status
 */
interface GlobalRateLimit {
  limited: boolean;
  reset: number;
}

/**
 * Manages rate limits with a proper queue system to prevent hitting Discord's rate limits
 */
export class RateLimitManager {
  private static instance: RateLimitManager;
  private buckets = new Collection<string, BucketInfo>();
  private globalRateLimit: GlobalRateLimit = { limited: false, reset: 0 };
  private rest: REST | null = null;
  private rateLimitedUntil = new Collection<string, number>();

  // Private constructor for singleton
  private constructor() {
    // Empty constructor
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
      logger.warn(`[REST] Rate limit hit: ${JSON.stringify(data)}`);

      if (data.global) {
        this.globalRateLimit = {
          limited: true,
          reset: Date.now() + data.timeToReset,
        };
        logger.warn(
          `[REST] Global rate limit activated until ${new Date(this.globalRateLimit.reset).toISOString()}`
        );
      } else {
        const bucket = this.getBucket(data.route || "unknown");
        bucket.limited = true;
        bucket.reset = Date.now() + data.timeToReset;
        bucket.remaining = 0;
        logger.debug(
          `[REST] Rate limit for bucket ${data.route} until ${new Date(bucket.reset).toISOString()}`
        );
      }
    });

    logger.debug("Rate limit manager initialized and monitoring REST client");
  }

  /**
   * Handle rate limit data from Discord.js client events
   */
  public handleRateLimit(data: RateLimitData): void {
    const { route, timeToReset, global } = data;
    const resetTime = Date.now() + timeToReset;

    this.rateLimitedUntil.set(route, resetTime);
    logger.warn(
      `Rate limit hit for route ${route}. Retrying after ${new Date(resetTime).toISOString()}`
    );

    if (global) {
      this.globalRateLimit = {
        limited: true,
        reset: Date.now() + data.timeToReset,
      };
      logger.warn(
        `Global rate limit activated until ${new Date(this.globalRateLimit.reset).toISOString()}`
      );
    } else {
      const bucket = this.getBucket(route || "unknown");
      bucket.limited = true;
      bucket.reset = Date.now() + data.timeToReset;
      bucket.remaining = 0;
      logger.debug(`Rate limit for bucket ${route} until ${new Date(bucket.reset).toISOString()}`);
    }
  }

  /**
   * Handle a 429 rate limit error
   */
  public async handle429(route: string, headers: Record<string, string>): Promise<void> {
    logger.warn(`429 Rate limit hit on ${route}, retrying after delay`);

    // Update rate limit information
    this.updateFromHeaders(route, headers);

    // Wait based on retry-after header
    const retryAfter = headers["retry-after"] ? parseInt(headers["retry-after"], 10) * 1000 : 5000;

    logger.debug(`Waiting ${retryAfter}ms before retrying request to ${route}`);
    await new Promise((resolve) => setTimeout(resolve, retryAfter));
  }

  /**
   * Check if a request should be allowed based on rate limits
   */
  public canMakeRequest(route: string): boolean {
    // Check global rate limit first
    if (this.globalRateLimit.limited) {
      if (Date.now() > this.globalRateLimit.reset) {
        this.globalRateLimit.limited = false;
        logger.trace("Global rate limit expired");
      } else {
        return false;
      }
    }

    // Check bucket-specific rate limit
    const bucket = this.getBucket(route);

    if (bucket.limited && Date.now() > bucket.reset) {
      bucket.limited = false;
      bucket.remaining = bucket.limit;
      logger.trace(`Rate limit for ${route} has reset`);
    }

    if (bucket.limited) {
      return false;
    }

    if (bucket.remaining <= 0) {
      bucket.limited = true;
      return false;
    }

    bucket.remaining--;
    return true;
  }

  /**
   * Wait until a request can be made
   */
  public async waitForRateLimit(route: string): Promise<void> {
    while (!this.canMakeRequest(route)) {
      // Wait for the smallest reset time between global and bucket-specific
      const globalWait = this.globalRateLimit.limited
        ? Math.max(0, this.globalRateLimit.reset - Date.now())
        : 0;

      const bucket = this.getBucket(route);
      const bucketWait = bucket.limited ? Math.max(0, bucket.reset - Date.now()) : 0;

      const waitTime = Math.max(globalWait, bucketWait, 100); // Minimum 100ms
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Update bucket info based on response headers
   */
  public updateFromHeaders(route: string, headers: Record<string, string>): void {
    const bucket = this.getBucket(route);

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

    if (headers["x-ratelimit-global"] === "true") {
      this.globalRateLimit.limited = true;
      if (headers["retry-after"]) {
        const retryAfter = Number(headers["retry-after"]) * 1000;
        this.globalRateLimit.reset = Date.now() + retryAfter;
      }
    }
  }

  /**
   * Get or create a rate limit bucket
   * @private
   */
  private getBucket(route: string): BucketInfo {
    if (!this.buckets.has(route)) {
      this.buckets.set(route, {
        limited: false,
        limit: 5, // Conservative default
        remaining: 5,
        reset: 0,
      });
    }
    const bucket = this.buckets.get(route);
    return (
      bucket ?? {
        limited: false,
        limit: 5,
        remaining: 5,
        reset: 0,
      }
    );
  }

  /**
   * Check if a route is rate limited
   */
  public isRateLimited(route: string): boolean {
    const resetTime = this.rateLimitedUntil.get(route);
    if (!resetTime) return false;
    return Date.now() < resetTime;
  }

  /**
   * Get the reset time for a rate-limited route
   */
  public getRateLimitedUntil(route: string): number | undefined {
    return this.rateLimitedUntil.get(route);
  }
}

// Export singleton instance
export const rateLimitManager = RateLimitManager.getInstance();
