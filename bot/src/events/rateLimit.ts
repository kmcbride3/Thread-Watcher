import { RateLimitData } from "discord.js";
import { logger } from "../bot";
import { handleRateLimit } from "../utilities/apiErrorHandler";

export default function (info: RateLimitData): void {
  logger.warn(`Rate limit hit: ${JSON.stringify(info)}`);
  handleRateLimit(info.retryAfter, info.global).then(() => {
    logger.info(`Resuming operations after delay of ${info.retryAfter}ms`);
  });
}