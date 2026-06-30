import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

/** Directions from the TARGET cell to a neighbour we could place against. Ordered best-first:
 *  the block below (place on its top face) is the most reliable, then the four sides, then the
 *  block above (place on its bottom face). For each, the face vector handed to placeBlock points
 *  from that neighbour back toward the target, so the new block lands exactly on the target cell. */
export const NEIGHBOURS: Vec3[] = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
];

/** Exact item name wins; otherwise the shortest partial match (so "planks" doesn't grab a variant
 *  arbitrarily). Mirrors the matching tossItem uses. */
export function findItem(bot: Bot, name: string) {
  const items = bot.inventory.items();
  return (
    items.find((i) => i.name === name) ??
    items.filter((i) => i.name.includes(name)).sort((a, b) => a.name.length - b.name.length)[0]
  );
}

/** Total count of an item the bot holds (exact name first, else summed partial matches). */
export function countItem(bot: Bot, name: string): number {
  const items = bot.inventory.items();
  const exact = items.filter((i) => i.name === name);
  const pool = exact.length ? exact : items.filter((i) => i.name.includes(name));
  return pool.reduce((n, i) => n + i.count, 0);
}

/** A cell we can place INTO: loaded and not already occupied by a solid block (air, grass, water,
 *  etc. are all replaceable). */
export function isReplaceable(bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos);
  return !!b && b.boundingBox !== 'block';
}

/** True if the block already at `pos` is the one we want there (so a rebuild/continue skips it). */
export function alreadyIs(bot: Bot, pos: Vec3, blockName: string): boolean {
  const b = bot.blockAt(pos);
  return !!b && (b.name === blockName || b.name.includes(blockName) || blockName.includes(b.name));
}

/** Tries to set a block down on `target`, placing against whichever neighbour works. Assumes the
 *  held item is already equipped and the bot is within reach. Returns false if the spot is occupied
 *  or has no solid face to build off of. */
export async function tryPlaceAt(bot: Bot, target: Vec3): Promise<boolean> {
  if (!isReplaceable(bot, target)) return false;
  for (const off of NEIGHBOURS) {
    const ref = bot.blockAt(target.plus(off));
    if (!ref || ref.boundingBox !== 'block') continue;
    const faceVector = off.scaled(-1); // neighbour -> target
    try {
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(ref, faceVector);
      return true;
    } catch {
      // try the next neighbour (occluded face, server rejected, etc.)
    }
  }
  return false;
}
