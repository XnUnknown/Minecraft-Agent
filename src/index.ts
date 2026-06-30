import { loadConfig } from './config/loadConfig';
import type { AgentProfile } from './config/loadConfig';
import { createBot } from './bot/createBot';
import { logger } from './util/logger';

const RECONNECT_DELAY_MS = 5000;

/**
 * Entrypoint: boot one bot per agent profile this process is responsible for, each with
 * its own independent auto-reconnect loop.
 *
 * Two ways to run multiple agents (see config/default.yaml's `agents:` list):
 * - No AGENT_NAME set: this process boots EVERY configured agent (one process, N bots).
 * - AGENT_NAME=<username> set: this process boots only that one profile — run it N times
 *   (N terminals, or scripts/launch-agents.ts) for N separate processes instead.
 */
function boot(config: ReturnType<typeof loadConfig>, profile: AgentProfile, peerUsernames: string[]): void {
  const bot = createBot(config, profile, peerUsernames);

  bot.on('end', (reason) => {
    logger.warn(`[${profile.username}] Disconnected (${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(() => boot(config, profile, peerUsernames), RECONNECT_DELAY_MS);
  });
}

function main(): void {
  const config = loadConfig();
  const wanted = process.env.AGENT_NAME?.trim();

  const toRun = wanted ? config.agents.filter((a) => a.username === wanted) : config.agents;
  if (wanted && toRun.length === 0) {
    logger.error(`AGENT_NAME="${wanted}" doesn't match any agent in config.agents.`);
    process.exit(1);
  }

  for (const profile of toRun) {
    const peerUsernames = config.agents.map((a) => a.username).filter((u) => u !== profile.username);
    boot(config, profile, peerUsernames);
  }
}

main();
