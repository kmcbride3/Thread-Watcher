import { logger } from "../index";

// Track counts of different error types
const invalidRequestLog: Record<string, number> = {
  "401": 0, // Unauthorized
  "403": 0, // Forbidden
  "429": 0, // Rate Limited
  "404": 0, // Not Found
};

/**
 * Extract HTTP status code from errors
 */
function getStatusCode(error: unknown): number | null {
  // Handle Discord.js API errors
  if (error && typeof error === "object") {
    // Check for common error formats
    if ("status" in error && typeof error.status === "number") {
      return error.status;
    }
    if ("statusCode" in error && typeof error.statusCode === "number") {
      return error.statusCode;
    }
    if ("code" in error && typeof error.code === "number") {
      return error.code;
    }
  }
  return null;
}

/**
 * Handle API errors with retry logic and status code tracking
 * @param error The error that occurred
 * @param retryFn A function to retry the operation
 * @param maxRetries Maximum number of retry attempts
 * @param delay Delay between retries in ms
 * @returns Promise that resolves with the retry result or rejects if all retries fail
 */
export async function handleApiError<T>(
  error: unknown,
  retryFn: () => Promise<T>,
  maxRetries = 1,
  delay = 1000
): Promise<T> {
  // Check for specific status codes and track them
  const statusCode = getStatusCode(error);
  if (statusCode) {
    const statusString = statusCode.toString();
    if (statusString in invalidRequestLog) {
      invalidRequestLog[statusString]++;

      // Log different messages based on status code
      switch (statusCode) {
        case 401:
          logger.warn("API Error: Unauthorized. Check your bot token.");
          break;
        case 403:
          logger.warn("API Error: Forbidden. The bot doesn't have the required permissions.");
          break;
        case 429:
          logger.warn("API Error: Rate limited. Waiting before retry.");
          // For rate limits, we might want to use a longer delay
          delay = Math.max(delay, 5000);
          break;
        case 404:
          logger.warn("API Error: Resource not found. It may have been deleted.");
          break;
        default:
          logger.warn(
            `API Error (${statusCode}): ${error instanceof Error ? error.message : String(error)}`
          );
      }
    } else {
      logger.warn(
        `API Error (${statusCode}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    // Generic error handling for non-HTTP errors
    logger.warn(`API Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Check if we should retry
  if (maxRetries <= 0 || statusCode === 404) {
    // Don't retry 404s
    throw error;
  }

  // Wait before retrying, with increased delay for rate limits
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    // Attempt retry
    logger.debug(`Retrying operation (${maxRetries} attempts remaining)`);
    return await retryFn();
  } catch (retryError) {
    // Recursive retry with one fewer attempt
    return handleApiError(retryError, retryFn, maxRetries - 1, delay * 1.5);
  }
}

/**
 * Log stats about invalid requests
 */
export const logInvalidRequests = () => {
  const logString = Object.entries(invalidRequestLog)
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");

  logger.info(`Invalid request stats: ${logString || "None"}`);
};
