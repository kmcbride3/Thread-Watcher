import { logger } from "../index";
import { ErrorSeverity, handleApiError } from "./errorSystem";

/**
 * Safely execute a fetch request with robust error handling and reporting
 * @param url The URL to fetch
 * @param options Fetch options
 * @param apiErrorOptions Configuration for error handling
 * @returns The response data or null if an error occurred
 */
export async function safeFetch<T>(
  url: string,
  options?: RequestInit,
  apiErrorOptions: {
    retries?: number;
    retryDelay?: number;
    reportErrors?: boolean;
  } = {}
): Promise<T | null> {
  const { reportErrors = true } = apiErrorOptions;

  try {
    return await handleApiError(
      null, // No initial error
      async () => {
        const response: Response = await fetch(url, {
          ...options,
          headers: {
            "User-Agent": "Thread-Watcher Bot/1.0",
            ...(options?.headers || {}),
          },
        });

        if (!response.ok) {
          const error: Error & { status?: number; url?: string } = new Error(
            `Request failed with status ${response.status}`
          );
          error.status = response.status;
          error.url = url;
          throw error;
        }
        const data: T = await response.json();
        return data;
      },
      {
        reportAtSeverity: reportErrors ? ErrorSeverity.HIGH : ErrorSeverity.CRITICAL,
        context: `HTTP Request to ${url}`,
      }
    );
  } catch (err) {
    logger.error(`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Validate a Discord snowflake ID
 * @param id The ID to validate
 * @returns True if the ID is valid, false otherwise
 */
export function isValidDiscordId(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

/**
 * Sanitize a string for safe display in HTML/output
 * @param input The input string
 * @returns The sanitized string
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
