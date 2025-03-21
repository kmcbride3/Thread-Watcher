/**
 * Interface representing a watched thread in the system
 */
export interface WatchedThread {
  id: string;
  server: string;
  watching: boolean;
  dueArchive?: number;
  shardId?: number; // Keep shardId in memory interface
}

/**
 * Result of a thread bump operation
 */
export interface ThreadBumpResult {
  success: boolean;
  method?: string;
  statusChange?: boolean;
  message?: string;
}

/**
 * Interface for thread registry entry that extends WatchedThread
 */
export interface ThreadRegistryEntry extends Omit<WatchedThread, "id"> {
  threadId: string; // We use threadId instead of id to be more explicit
  parentId: string | null;
  lastActivity: number;
  lastMaintenance: number;
  needsMaintenance: boolean;
  bumpAttempts: number;
  isProblematic: boolean;
  shardId: number;
  // server is inherited from WatchedThread as guildId
  // watching status is inherited from WatchedThread
  // dueArchive is inherited from WatchedThread
}

/**
 * Result of a thread maintenance operation
 */
export interface ThreadMaintenanceResult {
  keptActive: number;
  notFound: number;
  noPermissions: number;
  failedToActivate: number;
  messageSent: number;
  total: number;
}

/**
 * Valid thread maintenance result types
 */
export type ThreadMaintenanceResultType =
  | "kept-active"
  | "not-found"
  | "no-permissions"
  | "failed-to-activate"
  | "message-sent"
  | "error";

/**
 * Response from an individual thread maintenance operation
 */
export interface ThreadMaintenanceResponse {
  threadId: string;
  result: ThreadMaintenanceResultType;
  error?: unknown;
}
