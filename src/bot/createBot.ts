import mineflayer, { type Bot } from 'mineflayer';
import type { AppConfig } from '../config/loadConfig';
import { logger } from '../util/logger';
import { loadPlugins } from './plugins';
import { registerChatCommands } from '../control/chatCommands';
import { Blackboard } from '../blackboard/Blackboard';
import { Perception } from '../perception/Perception';
import { ReflexLayer } from '../reflex/ReflexLayer';
import { configureMovements, StuckMonitor } from './movement';
import { recordSent } from '../util/chat';

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

  // mineflayer defers actually attaching plugin methods (bot.chat included) until
  // 'inject_allowed' fires post-connection — bot.chat doesn't exist yet right after
  // createBot() returns. Wrap it once it does, so EVERY send path (direct bot.chat() calls,
  // sendChat()'s chunking, plugins) is tracked automatically; the chat listener uses this to
  // recognize and skip our own echoed messages instead of treating them as a player command.
  bot.once('inject_allowed', () => {
    const sendChatMessage = bot.chat.bind(bot);
    bot.chat = (message: string): void => {
      recordSent(message);
      sendChatMessage(message);
    };
  });

  const blackboard = new Blackboard();
  const perception = new Perception(bot, blackboard);
  const reflex = new ReflexLayer(bot);
  const stuckMonitor = new StuckMonitor(bot);

  // mineflayer-pvp/collectblock still listen on the deprecated 'physicTick' event, which
  // makes mineflayer print a one-time warning. Drop just that line; keep all other warns.
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].includes('deprecated event (physicTick)')) return;
    origWarn(...(args as []));
  };

  loadPlugins(bot);
  registerChatCommands(bot, config, perception, reflex);

  bot.once('spawn', () => {
    logger.info(`Spawned into the world as "${bot.username}". Position: ${bot.entity.position}`);
    configureMovements(bot);
    perception.start();
    reflex.start();
    stuckMonitor.start();
    bot.chat('Agent online. Try: come | stop | pos | status | pov, or just tell me what to do.');
  });

  bot.on('kicked', (reason) => logger.warn(`Kicked: ${JSON.stringify(reason)}`));
  bot.on('error', (err) => logger.error(`Bot error: ${err.message}`));

  return bot;
}
