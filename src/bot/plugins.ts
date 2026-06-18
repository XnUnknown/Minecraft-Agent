import type { Bot } from 'mineflayer';
// mineflayer-pathfinder is CommonJS; default-import then destructure so Node's ESM
// loader doesn't choke on undetected named exports.
import pathfinderPkg from 'mineflayer-pathfinder';

const { pathfinder } = pathfinderPkg;

/**
 * Registers Mineflayer plugins on the bot. Grows as later stages add combat,
 * collection, auto-eat, etc. Stage 2: navigation only.
 */
export function loadPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinder);
}
