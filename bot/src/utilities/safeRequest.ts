import { logger } from "../index";

/**
 * Safely execute a fetch request with proper error handling
 * @param url The URL to fetch
 * @param options Fetch options
 * @returns The response data or null if an error occurred
 */
export async function safeFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options?.headers || {}),
        "User-Agent": "Thread-Watcher Bot/1.0",
      },
    });

    if (!response.ok) {
      logger.warn(`Request to ${url} failed with status ${response.status}`);
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    logger.error(`Error fetching ${url}: ${error}`);
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
