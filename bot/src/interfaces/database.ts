export interface ReturnData {
  id: string;
  server: string;
}

export type ThreadData = ReturnData & {
  dueArchive: number;
  watching: boolean;
};

export type ChannelData = ReturnData & {
  regex: string;
  roles: (string | null | undefined)[];
  tags: (string | null | undefined)[];
};

export interface Database {
  createTables: () => Promise<void>;
  insertChannel: (data: ChannelData) => Promise<void>;
  insertThread: (
    id: string,
    dueArchive: number,
    server: string,
  ) => Promise<void>;
  updateDueArchive: (id: string, dueArchive: number) => Promise<void>;
  getChannels: (server: string) => Promise<ChannelData[]>;
  getThreads: (server: string) => Promise<ThreadData[]>;
  deleteThread: (threadID: string) => Promise<void>;
  deleteChannel: (channelID: string) => Promise<void>;
  deleteGuild: (server: string) => Promise<void>;
  unwatchThread: (threadID: string) => Promise<void>;
  getNumberOfThreads: () => Promise<number>;
  getNumberOfChannels: () => Promise<number>;
  setConfigValue: (
    server: string,
    key: string,
    value: string,
  ) => Promise<void>;
  deleteConfigValue: (server: string, key: string) => Promise<void>;
  getConfigValue: (server: string, key: string) => Promise<string>;
  createBackup: (baseDir: string) => Promise<string>;
  getAllWatchedThreads: () => Promise<ThreadData[]>;
  close: () => Promise<void>;
}

export interface BackupProvider {
  createBackup: (path: string) => Promise<`https://${string}` | null>;
}
