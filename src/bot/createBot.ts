import mineflayer, { type Bot } from 'mineflayer';
import type { AppConfig, AgentProfile } from '../config/loadConfig';
import { logger } from '../util/logger';
import { loadPlugins } from './plugins';
import { registerChatCommands } from '../control/chatCommands';
import { Blackboard } from '../blackboard/Blackboard';
import { Perception } from '../perception/Perception';
import { ReflexLayer } from '../reflex/ReflexLayer';
import { configureMovements, StuckMonitor } from './movement';
import { installDigGuard } from './digGuard';
import { recordSent } from '../util/chat';

let warnPatched = false;

/**
 * Create one Mineflayer bot for `profile`, register plugins, wire chat commands and
 * lifecycle events. `peerUsernames` are every OTHER agent configured alongside this one
 * (empty in the single-bot case), used for name-routed chat — see chatCommands.ts.
 */
export function createBot(config: AppConfig, profile: AgentProfile, peerUsernames: string[]): Bot {
  logger.info(
    `Connecting to ${config.server.host}:${config.server.port} as "${profile.username}" (auth=${config.server.auth})...`,
  );

  const bot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    username: profile.username,
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
      recordSent(bot, message);
      sendChatMessage(message);
    };
  });

  const blackboard = new Blackboard();
  const perception = new Perception(bot, blackboard);
  const reflex = new ReflexLayer(bot);
  const stuckMonitor = new StuckMonitor(bot);

  // mineflayer-pvp/collectblock still listen on the deprecated 'physicTick' event, which
  // makes mineflayer print a one-time warning. Drop just that line; keep all other warns.
  // Guarded so running several bots in one process doesn't nest the wrapper N times.
  if (!warnPatched) {
    warnPatched = true;
    const origWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]): void => {
      if (typeof args[0] === 'string' && args[0].includes('deprecated event (physicTick)')) return;
      origWarn(...(args as []));
    };
  }

  loadPlugins(bot);
  registerChatCommands(bot, config, profile, peerUsernames, perception, reflex);

  bot.once('spawn', () => {
    logger.info(`Spawned into the world as "${bot.username}". Position: ${bot.entity.position}`);
    configureMovements(bot);
    installDigGuard(bot);
    perception.start();
    reflex.start();
    stuckMonitor.start();
    bot.chat('Agent online. Try: come | stop | pos | status | pov | build, or just tell me what to do.');
  });

  bot.on('kicked', (reason) => logger.warn(`Kicked: ${JSON.stringify(reason)}`));
  bot.on('error', (err) => logger.error(`Bot error: ${err.message}`));

  return bot;
}
