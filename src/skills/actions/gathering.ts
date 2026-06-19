import type { Skill } from '../types';
import { clampInt } from '../util';
import { equipBestToolForBlock } from '../../util/equip';
import { searchOutward } from '../../util/navigate';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Suffixes shared by block "families" — every wood type has its own *_log, every ore its
 *  own *_ore, etc. A request for one variant should still succeed if a different variant
 *  of the same family is what's actually nearby (e.g. "oak_log" when only dark oak exists). */
const FAMILY_SUFFIXES = [
  '_log', '_wood', '_planks', '_leaves', '_sapling', '_ore', '_stairs', '_slab', '_fence',
  '_fence_gate', '_door', '_trapdoor', '_button', '_pressure_plate', '_wool', '_carpet',
  '_concrete', '_terracotta', '_stained_glass', '_bed',
];

export function familyIdsFor(blockType: string, blocksByName: Record<string, { id: number }>): number[] {
  const suffix = FAMILY_SUFFIXES.find((s) => blockType.endsWith(s));
  if (!suffix) return [];
  return Object.entries(blocksByName)
    .filter(([name]) => name.endsWith(suffix))
    .map(([, b]) => b.id);
}

export const collectBlock: Skill = {
  def: {
    name: 'collectBlock',
    description:
      'Find and harvest nearby blocks of a type, then pick up the drops. Use the EXACT block ' +
      'name from the Observation\'s "Notable blocks" list when one is shown (e.g. dark_oak_log, ' +
      'not just oak_log, if that is what is actually nearby) — a close variant of the same ' +
      'family will still be collected if the exact name is not available nearby.',
    parameters: {
      type: 'object',
      properties: {
        blockType: {
          type: 'string',
          description: 'Block name to collect, e.g. oak_log, dark_oak_log, stone, coal_ore.',
        },
        count: { type: 'integer', description: 'How many to collect (default 1).' },
      },
      required: ['blockType'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const blockType = String(args.blockType ?? '').toLowerCase();
    const count = clampInt(args.count, 1, 64, 1);

    const blocksByName =
      (bot.registry as unknown as { blocksByName?: Record<string, { id: number }> }).blocksByName ?? {};
    const exactId = blocksByName[blockType]?.id;
    const familyIds = familyIdsFor(blockType, blocksByName);
    if (exactId === undefined && familyIds.length === 0) {
      return { ok: false, message: `I don't know a block called "${blockType}".` };
    }
    const allIds = exactId !== undefined ? [exactId, ...familyIds] : familyIds;

    const isNearby = (): boolean => bot.findBlocks({ matching: allIds, maxDistance: 48, count: 1 }).length > 0;
    if (!isNearby()) {
      await searchOutward(bot, isNearby, ctx.reflex, ctx.shouldStop);
    }

    const collector = (bot as unknown as { collectBlock: { collect(b: unknown): Promise<void> } }).collectBlock;
    const reflex = ctx.reflex;
    let collected = 0;
    let failures = 0;
    let actualName = blockType;
    while (collected < count && failures < 3 && !ctx.shouldStop?.()) {
      // If the reflex layer is fleeing/fighting, let it finish before we mine again,
      // rather than aborting the whole gather job after a scrap.
      if (reflex?.isBusy()) {
        await sleep(300);
        continue;
      }
      let positions = exactId !== undefined ? bot.findBlocks({ matching: exactId, maxDistance: 48, count: 1 }) : [];
      if (!positions.length && familyIds.length) {
        positions = bot.findBlocks({ matching: familyIds, maxDistance: 48, count: 1 });
      }
      if (!positions.length) break;
      const block = bot.blockAt(positions[0]);
      if (!block) break;
      actualName = block.name;
      try {
        // Equip the fastest tool we own first, so breaking finishes quickly.
        await equipBestToolForBlock(bot, block);
        await collector.collect(block);
        collected += 1;
        failures = 0;
      } catch {
        // Interrupted (often by reflex combat). Wait it out and retry instead of giving up.
        if (reflex?.isBusy()) {
          await sleep(300);
          continue;
        }
        failures += 1;
      }
    }

    if (collected === 0) {
      return {
        ok: false,
        message: familyIds.length
          ? `Couldn't find any ${blockType} (or a similar variant) within range, even after looking around.`
          : `Couldn't collect any ${blockType} (none reachable nearby).`,
      };
    }
    return {
      ok: true,
      message:
        actualName === blockType
          ? `Collected ${collected}x ${actualName}.`
          : `Collected ${collected}x ${actualName} (closest match for ${blockType}).`,
    };
  },
};
