import { commands } from "../../bot";
import loadCommands from "../loadCommands";
import { logger } from "../../index";

/**
 * Reload all commands with proper error handling
 */
export default async function reloadCommands(): Promise<void> {
  try {
    logger.debug("Starting command reload...");
    
    // Get reference to commands collection
    const resolvedCommands = commands;
    
    // Clear existing commands
    resolvedCommands.clear();
    
    // Load commands asynchronously
    const loadedCommands = await loadCommands();
    
    // Add commands to collection
    for (const [key, value] of loadedCommands) {
      resolvedCommands.set(key, value);
    }
    
    logger.debug(`Reloaded ${loadedCommands.size} commands successfully`);
  } catch (error) {
    logger.error(`Failed to reload commands: ${error}`);
    throw error;
  }
}