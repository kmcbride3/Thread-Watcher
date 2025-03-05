import { REST, RequestMethod, RateLimitData } from "discord.js";
import { getConfig } from "./cnf/index";
import { rateLimitManager } from "./rateLimitManager";
import { logger } from "../index";

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
        logger.warn(`[REST] Rejecting request due to rate limit: ${JSON.stringify(rateLimitData)}`);
        return true;
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
    // Pass headers to rateLimitManager
    if (error && typeof error === "object" && "headers" in error) {
      rateLimitManager.updateFromHeaders(route, error.headers as Record<string, string>);
    }

    // Log meaningful error details
    const errorObj = error as {
      message?: string;
      code?: string;
      status?: number;
    };
    logger.error(`REST ${method} request to ${route} failed: ${errorObj.message || String(error)}`);
    if (errorObj.code) logger.error(`Error code: ${errorObj.code}`);
    if (errorObj.status) logger.error(`Status: ${errorObj.status}`);

    throw error;
  }
}
