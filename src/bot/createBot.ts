import mineflayer, { type Bot } from 'mineflayer';
import type { AppConfig } from '../config/loadConfig';
import { logger } from '../util/logger';
import { loadPlugins } from './plugins';
import { registerChatCommands } from '../control/chatCommands';

/**
 * Create the Mineflayer bot, register plugins, wire chat commands and lifecycle events.
 * Stage 1: join + greet. Stage 2: navigation plugin + manual chat control.
 */
export function createBot(config: AppConfig): Bot {
  logger.info(
    `Connecting to ${config.server.host}:${config.server.port} as "${config.agent.username}" (auth=${config.server.auth})...`,
  );

  const bot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    username: config.agent.username,
    auth: config.server.auth,
    version: config.server.version,
  });

  loadPlugins(bot);
  registerChatCommands(bot, config);

  bot.once('spawn', () => {
    logger.info(`Spawned into the world as "${bot.username}". Position: ${bot.entity.position}`);
    bot.chat('Agent online. Try: come | stop | pos');
  });

  bot.on('kicked', (reason) => logger.warn(`Kicked: ${JSON.stringify(reason)}`));
  bot.on('error', (err) => logger.error(`Bot error: ${err.message}`));

  return bot;
}
