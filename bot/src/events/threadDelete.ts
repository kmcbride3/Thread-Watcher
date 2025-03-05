import { Events, ThreadChannel } from 'discord.js';
import { threadManager } from '../utilities/threadManager';

export default {
  name: Events.ThreadDelete,
  once: false,
  execute(thread: ThreadChannel) {
    threadManager.unwatchThread(thread.id)
  }
}