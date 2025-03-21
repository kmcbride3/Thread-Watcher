import { getCommands } from "../../bot";
import { logger } from "../../index";
import { ErrorSeverity, handleApiError } from "../errorSystem";
import loadCommands from "../loadCommands";

const commands = getCommands();

/**
 * Reload all commands with proper error handling
 */
export default function reloadCommands(): Promise<void> {
  return handleApiError(
    "Failed to reload commands",
    async () => {
      logger.debug("Starting command reload...");

      // Get reference to commands collection
      const resolvedCommands = commands;

      // Clear existing commands
      resolvedCommands.clear();

      // Load commands asynchronously
      const loadedCommands = await loadCommands();

      // Using Collection's forEach for efficient iteration
      loadedCommands.forEach((command, key) => {
        resolvedCommands.set(key, command);
      });

      logger.debug(`Reloaded ${loadedCommands.size} commands successfully`);
    },
    {
      retries: 2,
      retryDelay: 1000,
      reportAtSeverity: ErrorSeverity.HIGH,
      context: "Command Reloading System",
    }
  );
}
