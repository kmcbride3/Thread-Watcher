import { REST, RateLimitData, RequestMethod } from "discord.js";
import { logger } from "../index";
import { getConfig } from "./cnf/index";
import { rateLimitManager } from "./rateLimitManager";

// Create a enhanced REST client for efficient API usage
let restClient: REST | null = null;

/**
 * Get the Discord REST client with rate limit awareness
 */
export function getRestClient(): REST {
  if (!restClient) {
    const config = getConfig();

    // Create REST client with improved options
    restClient = new REST({
      version: "10",
      retries: 3,
      timeout: 15000,
      globalRequestsPerSecond: 50,
      invalidRequestWarningInterval: 10,
      rejectOnRateLimit: (rateLimitData: RateLimitData) => {
        // Only log warning for significant rate limits
        if (rateLimitData.timeToReset > 1000) {
          logger.warn(
            `[REST] Rate limit detected for route: ${rateLimitData.route}, reset in ${rateLimitData.timeToReset}ms`
          );
        }

        // Only reject on global rate limits or very long timeouts
        // This allows most rate limits to be handled by automatic retries
        const shouldReject =
          rateLimitData.global ||
          rateLimitData.timeToReset > 5000 ||
          rateLimitData.route.includes("/messages");

        if (shouldReject) {
          logger.warn(`[REST] Rejecting request due to rate limit: ${rateLimitData.route}`);
        }

        return shouldReject;
      },
    }).setToken(config.tokens.discord);

    // Set the REST client in the rate limit manager
    rateLimitManager.setRest(restClient);

    logger.debug("REST client initialized and linked to rate limit manager");
  }
  return restClient;
}

/**
 * Safe REST request wrapper with improved error handling
 */
export async function safeRequest<T = unknown>(
  method: RequestMethod,
  route: string,
  options?: {
    body?: unknown;
    query?: URLSearchParams;
    headers?: Record<string, string>;
  }
): Promise<T> {
  const rest = getRestClient();
  const config = getConfig();
  // Only check logLevel for determining debug level
  const isDebugMode = config.logLevel && ["debug", "trace"].includes(config.logLevel);

  try {
    const response = await rest.request({
      method,
      fullRoute: `/${route.replace(/^\/+/, "")}` as `/${string}`,
      body: options?.body,
      query: options?.query,
      headers: options?.headers,
    });

    // Update rate limit info from successful response
    if (response && typeof response === "object" && "headers" in response) {
      rateLimitManager.updateFromHeaders(route, response.headers as Record<string, string>);
    }

    return response as T;
  } catch (error: unknown) {
    // Pass headers to rateLimitManager if available
    if (error && typeof error === "object" && "headers" in error) {
      try {
        rateLimitManager.updateFromHeaders(route, error.headers as Record<string, string>);
      } catch (rateLimitError) {
        // Don't let rate limit manager errors prevent the original error from being thrown
        logger.debug(`Error updating rate limit manager: ${rateLimitError}`);
      }
    }

    // Extract and log error details safely
    const errorObj = error as {
      message?: string;
      code?: string;
      status?: number;
      method?: string;
      url?: string;
    };

    // Create a more useful error message
    const statusText = errorObj.status ? `[${errorObj.status}]` : "";
    const codeText = errorObj.code ? `[${errorObj.code}]` : "";
    const methodText = errorObj.method || method;
    const urlText = errorObj.url || route;

    // Always log the basic error info
    logger.error(`REST ${methodText} request to ${urlText} failed ${statusText} ${codeText}`);

    // Only log detailed information when in debug mode
    if (isDebugMode) {
      const errorMessage =
        errorObj.message || (error instanceof Error ? error.message : String(error));
      logger.error(`Error details: ${errorMessage}`);

      // If we have a proper Error object with stack, log it in debug mode
      if (error instanceof Error && error.stack) {
        logger.debug(`Stack trace: ${error.stack}`);
      }
    }

    // Rethrow the original error
    throw error;
  }
}
