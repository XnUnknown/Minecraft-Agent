import type { Bot } from 'mineflayer';
import type { Skill } from '../types';
import { searchOutward, walkToward, type SearchOutwardOptions } from '../../util/navigate';
import { compassDirection, round } from '../../util/geometry';
import { familyIdsFor } from './gathering';

/** Wider and more patient than collectBlock/craftItem's built-in auto-retry — for when that
 *  already failed and it's worth actually committing to a real search. */
const WIDE_SEARCH: SearchOutwardOptions = {
  legs: [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ],
  legDistance: 48,
  legTimeoutMs: 20000,
};

interface SearchEntity {
  id: number;
  name?: string | null;
  position?: { x: number; y: number; z: number };
}

function findNamedEntity(bot: Bot, target: string): SearchEntity | null {
  for (const e of Object.values(bot.entities) as unknown as SearchEntity[]) {
    if (e?.position && (e.name ?? '').toLowerCase().includes(target)) return e;
  }
  return null;
}

export const searchWide: Skill = {
  def: {
    name: 'searchWide',
    description:
      'Search a much wider area than normal for something not found nearby, then walk to it. ' +
      'Use this as a FOLLOW-UP after collectBlock/attackNearestMob/tradeWithVillager already ' +
      "reported nothing nearby — not as a first attempt, since it walks far and takes a while. " +
      'Works for a block name/family (e.g. iron_ore) or a creature/entity name (e.g. villager, ' +
      'polar_bear).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Block or entity name to look for, e.g. iron_ore, villager.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const target = String(args.target ?? '').toLowerCase();
    if (!target) return { ok: false, message: 'No target given.' };

    const blocksByName =
      (bot.registry as unknown as { blocksByName?: Record<string, { id: number }> }).blocksByName ?? {};
    const exactBlockId = blocksByName[target]?.id;
    const familyIds = familyIdsFor(target, blocksByName);
    const blockIds = exactBlockId !== undefined ? [exactBlockId, ...familyIds] : familyIds;

    if (blockIds.length) {
      const findIt = () => bot.findBlock({ matching: blockIds, maxDistance: 64 });
      let block = findIt();
      if (!block) {
        await searchOutward(bot, () => !!findIt(), ctx.reflex, ctx.shouldStop, WIDE_SEARCH);
        block = findIt();
      }
      if (!block) return { ok: false, message: `Searched far and wide but couldn't find ${target}.` };

      const dest = block.position;
      const arrived = await walkToward(bot, () => dest, 3, ctx.reflex, ctx.shouldStop);
      const dist = round(bot.entity.position.distanceTo(dest));
      return arrived
        ? { ok: true, message: `Found ${block.name} ${dist}m ${compassDirection(bot.entity.position, dest)} and headed there.` }
        : { ok: false, message: `Found ${block.name} but couldn't reach it.` };
    }

    // Not a known block name — try matching a loaded entity by name instead.
    let entity = findNamedEntity(bot, target);
    if (!entity) {
      await searchOutward(bot, () => !!findNamedEntity(bot, target), ctx.reflex, ctx.shouldStop, WIDE_SEARCH);
      entity = findNamedEntity(bot, target);
    }
    if (!entity) return { ok: false, message: `Searched far and wide but couldn't find ${target}.` };

    const id = entity.id;
    const name = entity.name ?? target;
    const arrived = await walkToward(bot, () => bot.entities[id]?.position ?? null, 3, ctx.reflex, ctx.shouldStop);
    const pos = bot.entities[id]?.position ?? entity.position;
    const dist = pos ? round(bot.entity.position.distanceTo(pos)) : null;
    return arrived
      ? { ok: true, message: `Found ${name}${dist !== null ? ` ${dist}m away` : ''} and headed there.` }
      : { ok: false, message: `Found ${name} but couldn't reach it.` };
  },
};
