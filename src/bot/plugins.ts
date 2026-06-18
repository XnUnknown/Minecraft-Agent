import type { Bot } from 'mineflayer';
// These plugins are CommonJS; default-import then destructure so Node's ESM loader
// doesn't choke on undetected named exports.
import baritonePkg from '@miner-org/mineflayer-baritone';
import pvpPkg from 'mineflayer-pvp';
import collectBlockPkg from 'mineflayer-collectblock';
import toolPkg from 'mineflayer-tool';

const { loader: ashfinder } = baritonePkg;
const { plugin: pvp } = pvpPkg as unknown as { plugin: (bot: Bot) => void };
const { plugin: collectBlock } = collectBlockPkg as unknown as { plugin: (bot: Bot) => void };
const { plugin: tool } = toolPkg as unknown as { plugin: (bot: Bot) => void };

/**
 * Registers Mineflayer plugins on the bot.
 * - ashfinder (baritone): navigation
 * - pvp: melee/ranged combat (bot.pvp.attack/stop)
 * - tool: best-tool selection (used by collectblock)
 * - collectblock: walk-to + mine + pick-up (bot.collectBlock.collect)
 */
export function loadPlugins(bot: Bot): void {
  bot.loadPlugin(ashfinder);
  bot.loadPlugin(tool);
  bot.loadPlugin(pvp);
  bot.loadPlugin(collectBlock);
}
