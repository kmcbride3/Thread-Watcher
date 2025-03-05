import { WebhookClient, EmbedBuilder, Colors } from 'discord.js';
import { getConfig } from './cnf/index';
import { logger } from '../index';

export function reportError(error: Error, context = 'Unknown context'): void {
  // Log the error locally first
  logger.error(`[${context}] ${error.message}`);
  if (error.stack) logger.error(error.stack);
  
  // Then send to webhook if configured
  const config = getConfig();
  if (!config.logWebhook) return;
  
  const webhook = new WebhookClient({ url: config.logWebhook });
  
  const embed = new EmbedBuilder()
    .setTitle(`Error: ${error.name}`)
    .setDescription(`\`\`\`\n${error.message}\n\`\`\``)
    .addFields([
      { name: 'Context', value: context },
      { name: 'Stack', value: `\`\`\`\n${error.stack?.slice(0, 1000) || 'No stack trace'}\n\`\`\`` }
    ])
    .setColor(Colors.Red)
    .setTimestamp();
  
  webhook.send({ embeds: [embed] }).catch(err => {
    logger.error(`Failed to send error to webhook: ${err}`);
  });
}
