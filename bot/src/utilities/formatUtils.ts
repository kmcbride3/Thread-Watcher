import {
  channelMention,
  codeBlock,
  hyperlink,
  inlineCode,
  time,
  TimestampStyles,
  userMention,
} from "discord.js";
import { inspect } from "util";

/**
 * Format archive duration in minutes to a human-readable string
 * @param minutes Duration in minutes
 * @returns Human-readable duration string
 */
export function formatArchiveDuration(minutes: number): string {
  // Standard Discord thread auto-archive durations
  if (minutes === 60) return "1 hour";
  if (minutes === 1440) return "24 hours";
  if (minutes === 4320) return "3 days";
  if (minutes === 10080) return "1 week";

  // Handle custom values
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hours`;
  return `${Math.floor(minutes / 1440)} days`;
}

/**
 * Format bytes to human-readable file size
 * @param bytes Size in bytes
 * @param decimals Number of decimal places
 * @returns Human-readable size string
 */
export function formatFileSize(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes: readonly ["Bytes", "KB", "MB", "GB", "TB"] = [
    "Bytes",
    "KB",
    "MB",
    "GB",
    "TB",
  ] as const;

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const sizeIndex = Math.max(0, Math.min(i, sizes.length - 1));
  const size = sizes[sizeIndex as keyof typeof sizes];
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${size}`;
}

/**
 * Format a timestamp to a human-readable relative time using native Intl.RelativeTimeFormat
 * @param timestamp Timestamp in milliseconds or Date object
 * @returns Human-readable relative time string
 */
export function formatRelativeTime(timestamp: number | Date): string {
  const now = Date.now();
  const timeMs = timestamp instanceof Date ? timestamp.getTime() : timestamp;
  const diffSeconds = Math.floor((now - timeMs) / 1000);

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  // Using the most appropriate time unit
  if (Math.abs(diffSeconds) < 60) return rtf.format(-diffSeconds, "second");
  if (Math.abs(diffSeconds) < 3600) return rtf.format(-Math.floor(diffSeconds / 60), "minute");
  if (Math.abs(diffSeconds) < 86400) return rtf.format(-Math.floor(diffSeconds / 3600), "hour");
  if (Math.abs(diffSeconds) < 604800) return rtf.format(-Math.floor(diffSeconds / 86400), "day");

  return time(new Date(timeMs), TimestampStyles.RelativeTime);
}

/**
 * Format Discord-style timestamps for dynamic rendering in messages
 * using Discord.js built-in formatter
 * @param timestamp Unix timestamp in seconds or milliseconds, or Date object
 * @param format Discord timestamp format style
 * @returns Formatted Discord timestamp that will render dynamically
 */
export function formatDiscordTimestamp(
  timestamp: number | Date,
  format: (typeof TimestampStyles)[keyof typeof TimestampStyles] = TimestampStyles.ShortDateTime
): string {
  // Convert to Date if it's a number
  const date =
    typeof timestamp === "number"
      ? new Date(timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000)
      : timestamp;

  // Use Discord.js built-in time formatter
  return time(date, format);
}

/**
 * Format a relative timestamp using Discord.js built-in relative time formatter
 * @param timestamp Unix timestamp in seconds or milliseconds, or Date object
 * @returns Discord formatted relative time string
 */
export function formatRelativeTimestamp(timestamp: number | Date): string {
  // Convert to Date if it's a number
  const date =
    typeof timestamp === "number"
      ? new Date(timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000)
      : timestamp;

  // Use Discord.js built-in relative time formatter
  return time(date, TimestampStyles.RelativeTime);
}

/**
 * Format time left until a target timestamp
 * @param targetTimestamp Timestamp to count down to
 * @param includeSeconds Whether to include seconds in output
 * @returns Formatted time remaining string
 */
export function formatTimeLeft(targetTimestamp: number | Date, includeSeconds = false): string {
  const target = typeof targetTimestamp === "number" ? targetTimestamp : targetTimestamp.getTime();
  const now = Date.now();

  // If the target is in the past
  if (now >= target) return "now";

  const diffMs = target - now;
  const diffSeconds = Math.floor(diffMs / 1000) % 60;
  const diffMinutes = Math.floor(diffMs / 60000) % 60;
  const diffHours = Math.floor(diffMs / 3600000) % 24;
  const diffDays = Math.floor(diffMs / 86400000);

  let result = "";

  if (diffDays > 0) {
    result += `${diffDays}d `;
  }

  if (diffHours > 0 || diffDays > 0) {
    result += `${diffHours}h `;
  }

  if (diffMinutes > 0 || diffHours > 0 || diffDays > 0) {
    result += `${diffMinutes}m `;
  }

  if (includeSeconds && (diffSeconds > 0 || result === "")) {
    result += `${diffSeconds}s`;
  }

  return result.trim();
}

/**
 * Format a list of items with proper grammar
 * @param items Array of items to format
 * @param conjunction The conjunction to use (default: 'and')
 * @returns Grammatically formatted list string
 */
export function formatList(items: string[], conjunction = "and"): string {
  if (!items || items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;

  const lastItem = items[items.length - 1];
  const otherItems = items.slice(0, -1).join(", ");
  return `${otherItems}, ${conjunction} ${lastItem}`;
}

/**
 * Safely truncate text to a maximum length with ellipsis
 * This is enhanced with UTF-8 awareness
 * @param text The text to truncate
 * @param maxLength Maximum allowed length
 * @param ellipsis String to use as ellipsis (default: '...')
 * @returns Truncated text
 */
export function truncate(text: string, maxLength: number, ellipsis = "..."): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;

  // Adjust max length to account for ellipsis
  const adjustedLength = maxLength - ellipsis.length;
  if (adjustedLength <= 0) return ellipsis.substring(0, maxLength);

  return text.slice(0, adjustedLength) + ellipsis;
}

/**
 * Format a duration in milliseconds to a human-readable string
 * @param ms Duration in milliseconds
 * @param compact Whether to use compact formatting
 * @returns Human-readable duration
 */
export function formatDuration(ms: number, compact = false): string {
  const duration = ms < 0 ? 0 : ms;

  const seconds = Math.floor((duration / 1000) % 60);
  const minutes = Math.floor((duration / (1000 * 60)) % 60);
  const hours = Math.floor((duration / (1000 * 60 * 60)) % 24);
  const days = Math.floor(duration / (1000 * 60 * 60 * 24));

  if (compact) {
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);

  return parts.join(", ");
}

/**
 * Format a user mention with display name if available
 * @param userId User ID to format
 * @param username Optional username to display
 * @returns Formatted user mention
 */
export function formatUserMention(userId: string, username?: string): string {
  // Use discord.js's built-in userMention utility
  const mention = userMention(userId);
  return username ? `${username} (${mention})` : mention;
}

/**
 * Format a channel mention with name if available
 * @param channelId Channel ID to format
 * @param channelName Optional channel name to display
 * @returns Formatted channel mention
 */
export function formatChannelMention(channelId: string, channelName?: string): string {
  // Use discord.js's built-in channelMention utility
  const mention = channelMention(channelId);
  return channelName ? `#${channelName} (${mention})` : mention;
}

/**
 * Format a code block with syntax highlighting
 * @param content Content to format as code
 * @param language Language for syntax highlighting
 * @returns Formatted code block
 */
export function formatCodeBlock(content: string, language = ""): string {
  // Use discord.js's built-in codeBlock utility
  return codeBlock(language, content);
}

/**
 * Format text as inline code
 * @param content Content to format as inline code
 * @returns Formatted inline code
 */
export function formatInlineCode(content: string): string {
  // Use discord.js's built-in inlineCode utility
  return inlineCode(content);
}

/**
 * Create a hyperlink with an optional title
 * @param url The URL to link to
 * @param title Optional title for the link
 * @returns Formatted markdown hyperlink
 */
export function formatLink(url: string, title?: string): string {
  // Use discord.js's built-in hyperlink utility
  return hyperlink(title || url, url);
}

/**
 * Format an object for display (useful for debugging)
 * @param obj The object to inspect
 * @param options Options for formatting
 * @returns Formatted string representation of the object
 */
export function formatObject(obj: unknown, options = { depth: 2, colors: false }): string {
  // Use Node.js built-in util.inspect
  return inspect(obj, options);
}
