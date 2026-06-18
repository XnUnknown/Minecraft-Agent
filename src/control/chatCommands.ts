import type { Bot } from 'mineflayer';
// mineflayer-pathfinder is CommonJS; default-import then destructure (see bot/plugins.ts).
import pathfinderPkg from 'mineflayer-pathfinder';
import type { AppConfig } from '../config/loadConfig';
import { logger } from '../util/logger';
import { GoalRunner } from '../agent/goalRunner';

const { Movements, goals } = pathfinderPkg;

/** Hard-coded manual overrides (zero-cost, always available). */
const MANUAL = new Set(['come', 'stop', 'pos']);

/**
 * Stage 2: manual chat control (come / stop / pos).
 * Stage 3: any other chat text is routed to the LLM planner via GoalRunner.
 */
export function registerChatCommands(bot: Bot, config: AppConfig): void {
  const runner = new GoalRunner({
    maxMessages: config.conversation.maxMessages,
    keepRecent: config.conversation.keepRecent,
  });

  bot.once('spawn', () => {
    bot.pathfinder.setMovements(new Movements(bot));
    logger.info('Pathfinder ready. Manual: come | stop | pos. Any other chat -> LLM.');
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    const cmd = message.trim().toLowerCase();
    if (MANUAL.has(cmd)) {
      handleManual(bot, username, cmd);
      return;
    }
    void runner.handle(bot, username, message);
  });
}

function handleManual(bot: Bot, username: string, cmd: string): void {
  switch (cmd) {
    case 'come': {
      const target = bot.players[username]?.entity;
      if (!target) {
        bot.chat(`I can't see you, ${username} — come into render range.`);
        return;
      }
      const { x, y, z } = target.position;
      logger.info(`"${username}" said come -> pathfinding to (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
      bot.chat(`Coming to you, ${username}.`);
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
      break;
    }
    case 'stop': {
      bot.pathfinder.setGoal(null);
      bot.chat('Stopped.');
      logger.info(`"${username}" said stop -> movement cancelled`);
      break;
    }
    case 'pos': {
      const p = bot.entity.position;
      bot.chat(`I'm at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}.`);
      break;
    }
  }
}
