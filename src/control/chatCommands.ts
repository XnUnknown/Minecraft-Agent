import type { Bot } from 'mineflayer';
// mineflayer-pathfinder is CommonJS; default-import then destructure (see bot/plugins.ts).
import pathfinderPkg from 'mineflayer-pathfinder';
import type { AppConfig, AgentProfile } from '../config/loadConfig';
import type { Perception } from '../perception/Perception';
import type { ReflexLayer } from '../reflex/ReflexLayer';
import { logger } from '../util/logger';
import { GoalRunner } from '../agent/goalRunner';
import { startPov, stopPov } from '../viewer/PovViewer';
import { wasRecentlySent } from '../util/chat';
import { parseTargets } from './agentRouting';

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
 *
 * Multi-agent: `peerUsernames` are every other configured agent. A message is "for me"
 * if it names me (anywhere in the text, alongside any other agents) — or, when no other
 * agents are configured at all, if it names nobody (today's single-bot default, so chat
 * still needs no naming in that common case). Peer-agent senders (another bot, not a
 * human) get a direct busy-or-accept reply instead of silently queuing — see `isBusy()`.
 */
export function registerChatCommands(
  bot: Bot,
  config: AppConfig,
  profile: AgentProfile,
  peerUsernames: string[],
  perception: Perception,
  reflex: ReflexLayer,
): void {
  const runner = new GoalRunner(perception, reflex, peerUsernames, {
    maxMessages: config.conversation.maxMessages,
    keepRecent: config.conversation.keepRecent,
  });
  const knownNames = [profile.username, ...peerUsernames];

  bot.once('spawn', () => {
    logger.info('Chat control ready. Manual: come | pos | obs | pov | pov off. stop/status + any other chat -> agent.');
  });

  bot.on('chat', (username, message) => {
    if (username.trim().toLowerCase() === bot.username.trim().toLowerCase()) return;
    // Backstop for servers whose chat-formatting plugins rewrite the echoed username on our
    // own messages — without this the agent can end up "hearing" and reacting to itself.
    if (wasRecentlySent(bot, message)) return;

    const { targets, rest } = parseTargets(message, knownNames);
    const addressedToMe = targets.some((t) => t.toLowerCase() === profile.username.toLowerCase());
    const noNameGiven = targets.length === 0;
    const singleAgentMode = peerUsernames.length === 0;
    if (!addressedToMe && !(noNameGiven && singleAgentMode)) return; // meant for someone else

    const text = rest;
    const cmd = text.trim().toLowerCase();
    if (MANUAL.has(cmd)) {
      void handleManual(bot, username, cmd, perception, profile);
      return;
    }

    // A peer bot's request gets a direct busy-or-accept reply instead of silently queuing
    // behind whatever this agent is already doing — a human's request still queues as usual.
    const senderIsPeer = peerUsernames.some((p) => p.toLowerCase() === username.toLowerCase());
    if (senderIsPeer && runner.isBusy()) {
      bot.chat(`${username} I'm busy right now — ${runner.describeActivity(bot)}`);
      return;
    }

    void runner.handle(bot, username, text);
  });
}

async function handleManual(
  bot: Bot,
  username: string,
  cmd: string,
  perception: Perception,
  profile: AgentProfile,
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
      const result = await startPov(bot, profile.viewerPort);
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
