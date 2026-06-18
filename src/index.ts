import { loadConfig } from './config/loadConfig';
import { createBot } from './bot/createBot';
import { logger } from './util/logger';

const RECONNECT_DELAY_MS = 5000;

/**
 * Stage 1 entrypoint: boot the bot, and auto-reconnect on disconnect.
 * Later stages start Perception, the Reflex Layer, and the Orchestrator here.
 */
function boot(): void {
  const config = loadConfig();
  const bot = createBot(config);

  bot.on('end', (reason) => {
    logger.warn(`Disconnected (${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(boot, RECONNECT_DELAY_MS);
  });
}

boot();
