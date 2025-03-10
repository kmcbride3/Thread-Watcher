import { logger } from "../index";

/**
 * Handle API errors with retry logic
 * @param errorMessage The initial error message, or null if none
 * @param fn The function to execute
 * @param retries The number of retries to attempt
 * @param retryDelay The delay between retries in ms
 * @returns The result of the function
 * @throws The last error encountered after retries are exhausted
 */
export async function handleApiError<T>(
  errorMessage: string | null,
  fn: () => Promise<T>,
  retries = 2,
  retryDelay = 1000
): Promise<T> {
  let lastError: Error | unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const statusCode = getErrorStatusCode(error);

      // Handle specific status codes
      if (statusCode === 429) {
        const retryAfter = getRetryAfter(error) || retryDelay * Math.pow(2, attempt);
        logger.warn(
          `Rate limited by API, waiting ${retryAfter}ms before retry ${attempt + 1}/${retries}`
        );
        await sleep(retryAfter);
        continue;
      }

      // Don't retry these errors
      if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
        logger.error(
          `API Error ${statusCode}: ${errorMessage || ""} ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }

      // Retry server errors and network errors
      if (attempt < retries) {
        const delay = retryDelay * Math.pow(2, attempt);
        logger.warn(
          `API error (attempt ${attempt + 1}/${retries}): ${error instanceof Error ? error.message : String(error)}`
        );
        await sleep(delay);
      } else {
        if (errorMessage) {
          logger.error(
            `${errorMessage}: ${error instanceof Error ? error.message : String(error)}`
          );
        } else {
          logger.error(
            `API error after ${retries + 1} attempts: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Get the HTTP status code from an error if available
 */
function getErrorStatusCode(error: unknown): number | null {
  if (error && typeof error === "object") {
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
 * Get retry-after value from error if available
 */
function getRetryAfter(error: unknown): number | null {
  if (error && typeof error === "object") {
    if ("retryAfter" in error && typeof error.retryAfter === "number") {
      return error.retryAfter;
    }
    if ("retry-after" in error && typeof error["retry-after"] === "number") {
      return error["retry-after"];
    }
    if ("headers" in error && typeof error.headers === "object" && error.headers) {
      const headers = error.headers as Record<string, unknown>;
      if ("retry-after" in headers && typeof headers["retry-after"] === "string") {
        return parseInt(headers["retry-after"], 10) * 1000;
      }
    }
  }
  return null;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
