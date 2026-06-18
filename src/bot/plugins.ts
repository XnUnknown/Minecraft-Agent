import type { Bot } from 'mineflayer';
// These plugins are CommonJS; default-import then destructure so Node's ESM loader
// doesn't choke on undetected named exports.
import pathfinderPkg from 'mineflayer-pathfinder';
import pvpPkg from 'mineflayer-pvp';
import collectBlockPkg from 'mineflayer-collectblock';
import toolPkg from 'mineflayer-tool';

const { pathfinder } = pathfinderPkg;
const { plugin: pvp } = pvpPkg as unknown as { plugin: (bot: Bot) => void };
const { plugin: collectBlock } = collectBlockPkg as unknown as { plugin: (bot: Bot) => void };
const { plugin: tool } = toolPkg as unknown as { plugin: (bot: Bot) => void };

/**
 * Registers Mineflayer plugins on the bot.
 * - pathfinder: navigation
 * - pvp: melee/ranged combat (bot.pvp.attack/stop)
 * - tool: best-tool selection (used by collectblock)
 * - collectblock: walk-to + mine + pick-up (bot.collectBlock.collect)
 */
export function loadPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(tool);
  bot.loadPlugin(pvp);
  bot.loadPlugin(collectBlock);
}
