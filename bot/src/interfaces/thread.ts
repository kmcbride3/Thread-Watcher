/**
 * Interface representing a watched thread in the system
 */
export interface WatchedThread {
  id: string;
  server: string;
  watching: boolean;
  dueArchive?: number;
}
