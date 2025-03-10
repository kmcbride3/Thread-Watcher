import { CommandInteraction } from "discord.js";
import { logger } from "../index";
import { handleApiError as baseHandleApiError } from "./apiErrorHandler";
import { EmbedBuilderFunction } from "./embedUtils";
import { safeReplyWithError } from "./errorHandling";
import { reportError as baseReportError } from "./errorReporter";
import { formatCodeBlock, truncate } from "./formatUtils";

/**
 * Error severity levels for better error handling decisions
 */
export enum ErrorSeverity {
  DEBUG = 0, // Development issues, rarely reported
  LOW = 1, // Minor issues that don't affect functionality
  MEDIUM = 2, // Issues that degrade but don't prevent functionality
  HIGH = 3, // Issues that prevent certain features from working
  CRITICAL = 4, // Issues that could crash the application or cause data loss
}

/**
 * Extended options for the enhanced handleApiError function
 */
export interface ApiErrorOptions {
  retries?: number;
  retryDelay?: number;
  reportAtSeverity?: ErrorSeverity;
  context?: string;
}

/**
 * Enhanced API error handling with severity-based reporting
 * @param errorMessage Error message or null
 * @param fn The function to execute with error handling
 * @param options Configuration options
 */
export async function handleApiError<T>(
  errorMessage: string | null,
  fn: () => Promise<T>,
  options: ApiErrorOptions = {}
): Promise<T> {
  const {
    retries = 2,
    retryDelay = 1000,
    reportAtSeverity = ErrorSeverity.HIGH,
    context = "API Operation",
  } = options;

  try {
    // Use the base implementation for the core retry logic
    return await baseHandleApiError(errorMessage, fn, retries, retryDelay);
  } catch (error) {
    // Determine error severity based on the error
    const severity = determineErrorSeverity(error);

    // Report errors that meet or exceed the threshold
    if (severity >= reportAtSeverity) {
      if (error instanceof Error) {
        baseReportError(error, context);
      } else {
        baseReportError(new Error(typeof error === "string" ? error : "Unknown error"), context);
      }
    }

    // Re-throw to allow calling code to handle as needed
    throw error;
  }
}

/**
 * Handle command errors with consistent UI feedback and reporting
 */
export async function handleCommandError(
  interaction: CommandInteraction,
  error: unknown,
  embedBuilder: EmbedBuilderFunction,
  options: {
    errorTitle?: string;
    errorDescription?: string;
    context?: string;
    reportAtSeverity?: ErrorSeverity;
  } = {}
): Promise<void> {
  const {
    errorTitle = "Error",
    errorDescription = "An unexpected error occurred while processing your request.",
    context = "Command Interaction",
    reportAtSeverity = ErrorSeverity.HIGH,
  } = options;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorContext = context ? formatCodeBlock(context, "ini") : "";
  logger.error(`${errorContext}: ${truncate(errorMessage, 200)}`);

  // Determine severity and report if needed
  const severity = determineErrorSeverity(error);
  if (severity >= reportAtSeverity) {
    if (error instanceof Error) {
      baseReportError(error, context);
    } else {
      baseReportError(new Error(errorMessage), context);
    }
  }

  // Provide user feedback
  await safeReplyWithError(interaction, error, embedBuilder, errorTitle, errorDescription);
}

/**
 * Determine the severity of an error based on its type and properties
 */
function determineErrorSeverity(error: unknown): ErrorSeverity {
  if (!error) return ErrorSeverity.LOW;

  if (error instanceof Error) {
    // Truncate error messages for more readable logs
    const message = truncate(error.message, 500);
    const conditions: [RegExp, ErrorSeverity][] = [
      [/Failed to fetch|network|ECONNREFUSED|ETIMEDOUT/i, ErrorSeverity.MEDIUM],
      [/rate limit|429/i, ErrorSeverity.MEDIUM],
      [/Missing Access|Missing Permissions/i, ErrorSeverity.MEDIUM],
      [/Gateway|WebSocket/i, ErrorSeverity.HIGH],
      [/database|SQL|query failed/i, ErrorSeverity.CRITICAL],
      [/TOKEN_INVALID|401/i, ErrorSeverity.CRITICAL],
    ];
    for (const [regex, severity] of conditions) {
      if (regex.test(message)) {
        return severity;
      }
    }
  }

  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: number }).status;
    if (status === 429) return ErrorSeverity.MEDIUM; // Rate limit
    if (status >= 500) return ErrorSeverity.HIGH; // Server error
    if (status === 401 || status === 403) return ErrorSeverity.HIGH; // Auth error
    if (status === 404) return ErrorSeverity.MEDIUM; // Not found
  }

  return ErrorSeverity.MEDIUM;
}
