import type { Bot } from 'mineflayer';
// mineflayer-pathfinder is CommonJS; default-import then destructure (see bot/plugins.ts).
import pathfinderPkg from 'mineflayer-pathfinder';
import type { AppConfig } from '../config/loadConfig';
import type { Perception } from '../perception/Perception';
import type { ReflexLayer } from '../reflex/ReflexLayer';
import { logger } from '../util/logger';
import { GoalRunner } from '../agent/goalRunner';
import { startPov, stopPov } from '../viewer/PovViewer';

const { goals } = pathfinderPkg;

/**
 * Hard-coded manual overrides (zero-cost, always available). `obs` is a perception debug
 * aid. `pov`/`pov off` toggle the 3D viewer. Note: `stop` is intentionally NOT here — it's
 * routed to the GoalRunner so it cancels the whole task queue + active gathering/combat,
 * not just pathfinding.
 */
const MANUAL = new Set(['come', 'pos', 'obs', 'pov', 'pov on', 'pov off']);

/**
 * Stage 2: manual chat control (come / stop / pos).
 * Stage 3: any other chat text is routed to the LLM planner via GoalRunner.
 * Stage 4: GoalRunner observes via the shared Perception/Blackboard; `obs` dumps it.
 */
export function registerChatCommands(
  bot: Bot,
  config: AppConfig,
  perception: Perception,
  reflex: ReflexLayer,
): void {
  const runner = new GoalRunner(perception, reflex, {
    maxMessages: config.conversation.maxMessages,
    keepRecent: config.conversation.keepRecent,
  });

  bot.once('spawn', () => {
    logger.info('Chat control ready. Manual: come | pos | obs | pov | pov off. stop/status + any other chat -> agent.');
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    const cmd = message.trim().toLowerCase();
    if (MANUAL.has(cmd)) {
      void handleManual(bot, username, cmd, perception, config);
      return;
    }
    void runner.handle(bot, username, message);
  });
}

async function handleManual(
  bot: Bot,
  username: string,
  cmd: string,
  perception: Perception,
  config: AppConfig,
): Promise<void> {
  switch (cmd) {
    case 'obs': {
      const observation = perception.observe();
      logger.info(`OBSERVATION requested by ${username}:\n${observation}`);
      bot.chat('Posted my current observation to the console.');
      break;
    }
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
    case 'pov':
    case 'pov on': {
      const result = await startPov(bot, config.viewer.port);
      logger.info(`"${username}" said ${cmd} -> ${result.message}`);
      bot.chat(result.message);
      break;
    }
    case 'pov off': {
      const result = stopPov(bot);
      logger.info(`"${username}" said ${cmd} -> ${result.message}`);
      bot.chat(result.message);
      break;
    }
  }
}
