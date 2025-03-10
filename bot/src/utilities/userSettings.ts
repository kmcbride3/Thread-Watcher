import { Collection } from "discord.js";
import { logger } from "../index";
import { Database } from "../interfaces/database";
import { ErrorSeverity, handleApiError } from "./errorSystem";
import { rateLimitManager } from "./rateLimitManager";

export default class UserSettings {
  db: Database;
  cache: Collection<string, string>;

  constructor(db: Database) {
    this.db = db;
    this.cache = new Collection();
  }

  /**
   * Get a setting value with caching
   */
  async getSetting(guild: string, key: string): Promise<string> {
    const cacheKey = `${guild}/${key}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) || "";
    }

    await rateLimitManager.waitForRateLimit(`db/settings/${guild}`);

    try {
      const value = await handleApiError(
        null,
        async () => await this.db.getConfigValue(guild, key),
        {
          retries: 2,
          retryDelay: 500,
          reportAtSeverity: ErrorSeverity.MEDIUM,
          context: `UserSettings:get(${guild}/${key})`,
        }
      );

      this.cache.set(cacheKey, value);
      return value;
    } catch (error) {
      if (error === "NO ROW FOUND") {
        return ""; // Default value for missing settings
      }
      logger.error(`Error fetching setting ${key} for guild ${guild}: ${error}`);
      throw error;
    }
  }

  /**
   * Set a setting value with cache update
   */
  async setSetting(guild: string, key: string, value: string): Promise<void> {
    const cacheKey = `${guild}/${key}`;

    await rateLimitManager.waitForRateLimit(`db/settings/${guild}`);

    await handleApiError(
      null,
      async () => {
        await this.db.setConfigValue(guild, key, value);
        this.cache.set(cacheKey, value);
      },
      {
        retries: 2,
        retryDelay: 500,
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: `UserSettings:set(${guild}/${key})`,
      }
    );
  }

  /**
   * Remove a setting with cache update
   */
  async removeSetting(guild: string, key: string): Promise<void> {
    const cacheKey = `${guild}/${key}`;

    await rateLimitManager.waitForRateLimit(`db/settings/${guild}`);

    await handleApiError(
      null,
      async () => {
        await this.db.deleteConfigValue(guild, key);
        this.cache.delete(cacheKey);
      },
      {
        retries: 2,
        retryDelay: 500,
        reportAtSeverity: ErrorSeverity.MEDIUM,
        context: `UserSettings:remove(${guild}/${key})`,
      }
    );
  }

  /**
   * Clear cache for a guild
   */
  clearGuildCache(guild: string): void {
    this.cache.sweep((_, key) => key.startsWith(`${guild}/`));
  }
}
