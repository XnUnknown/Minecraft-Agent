import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import type { Skill } from '../types';
import { walkToward } from '../../util/navigate';

/** Directions from the TARGET cell to a neighbour we could place against. Ordered best-first:
 *  the block below (place on its top face) is the most reliable, then the four sides, then the
 *  block above (place on its bottom face). For each, the face vector handed to placeBlock points
 *  from that neighbour back toward the target, so the new block lands exactly on the target cell. */
const NEIGHBOURS: Vec3[] = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
];

/** Exact item name wins; otherwise the shortest partial match (so "planks" doesn't grab a variant
 *  arbitrarily). Mirrors the matching tossItem uses. */
function findItem(bot: Bot, name: string) {
  const items = bot.inventory.items();
  return (
    items.find((i) => i.name === name) ??
    items.filter((i) => i.name.includes(name)).sort((a, b) => a.name.length - b.name.length)[0]
  );
}

/** A cell we can place INTO: loaded and not already occupied by a solid block (air, grass, water,
 *  etc. are all replaceable). */
function isReplaceable(bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos);
  return !!b && b.boundingBox !== 'block';
}

/** Tries to set a block down on `target`, placing against whichever neighbour works. Assumes the
 *  held item is already equipped and the bot is within reach. Returns false if the spot is occupied
 *  or has no solid face to build off of. */
async function tryPlaceAt(bot: Bot, target: Vec3): Promise<boolean> {
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

export const placeBlock: Skill = {
  def: {
    name: 'placeBlock',
    description:
      'Place a block you are holding from inventory into the world. Give x,y,z to put it at a ' +
      'specific spot (the bot walks into reach first); omit the coordinates to just set it down in ' +
      'a clear spot right next to you. The spot must be empty and have an adjacent block (or the ' +
      'ground) to build against.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Block to place, e.g. cobblestone or oak_planks.' },
        x: { type: 'integer', description: 'Target X (optional — omit to place next to the bot).' },
        y: { type: 'integer', description: 'Target Y (optional).' },
        z: { type: 'integer', description: 'Target Z (optional).' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },

  async run(bot, args, ctx) {
    const name = String(args.item ?? '').toLowerCase().trim();
    if (!name) return { ok: false, message: 'Tell me which block to place.' };

    const item = findItem(bot, name);
    if (!item) return { ok: false, message: `I don't have any ${name} to place.` };
    try {
      await bot.equip(item, 'hand');
    } catch (err) {
      return { ok: false, message: `Couldn't hold ${item.name}: ${err instanceof Error ? err.message : String(err)}` };
    }

    const hasCoords = ['x', 'y', 'z'].every((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');

    if (hasCoords) {
      const target = new Vec3(Math.floor(Number(args.x)), Math.floor(Number(args.y)), Math.floor(Number(args.z)));
      if (bot.entity.position.distanceTo(target) > 3.5) {
        await walkToward(bot, () => target, 2, ctx.reflex, ctx.shouldStop);
      }
      const ok = await tryPlaceAt(bot, target);
      return ok
        ? { ok: true, message: `Placed ${item.name} at ${target.x}, ${target.y}, ${target.z}.` }
        : {
            ok: false,
            message: `Couldn't place ${item.name} at ${target.x}, ${target.y}, ${target.z} — the spot is occupied or has no block to build against.`,
          };
    }

    // No coordinates: drop it in the first clear cell beside me (foot level, then head level).
    const feet = bot.entity.position.floored();
    const candidates: Vec3[] = [
      feet.offset(1, 0, 0),
      feet.offset(-1, 0, 0),
      feet.offset(0, 0, 1),
      feet.offset(0, 0, -1),
      feet.offset(1, 1, 0),
      feet.offset(-1, 1, 0),
      feet.offset(0, 1, 1),
      feet.offset(0, 1, -1),
    ];
    for (const target of candidates) {
      if (await tryPlaceAt(bot, target)) {
        return { ok: true, message: `Placed ${item.name} at ${target.x}, ${target.y}, ${target.z} (next to me).` };
      }
    }
    return { ok: false, message: `Couldn't find a clear spot next to me to place ${item.name}.` };
  },
};
