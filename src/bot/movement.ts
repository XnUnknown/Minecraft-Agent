import type { Bot } from 'mineflayer';
import { logger } from '../util/logger';

/**
 * Configure the mineflayer-baritone (ashfinder) plugin settings.
 * Baritone handles its own physics and diagonal/jump behavior, so we don't need
 * custom Movements or Assist classes anymore.
 */
export function configureMovements(bot: Bot): void {
  const config = bot.ashfinder.config;

  // Configure Baritone's pathfinding rules
  config.set('parkour', true);
  config.set('breakBlocks', true);
  config.set('placeBlocks', true);
  config.set('allowSprinting', true); // Turn off sprinting to prevent overshoot
  config.set('fly', false);

  logger.info('Baritone configured: parkour enabled, block interaction allowed, sprinting disabled.');
}
