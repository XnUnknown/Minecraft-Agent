import type { Skill } from '../types';
import { clampInt, withTimeout, TimeoutError } from '../util';
import { equipBestToolForBlock } from '../../util/equip';
import { searchOutward } from '../../util/navigate';

/** Generous ceiling for walking to + mining ONE block. mineflayer-pathfinder can otherwise
 *  spin forever recomputing partial paths when a block turns out unreachable (e.g. boxed in
 *  by terrain it won't dig through) instead of erroring — without this the bot looks like it
 *  "just stands there" partway through a big gather job, with nothing ever reported back to
 *  the LLM so the loop never gets a chance to retry a different block or report failure. */
const COLLECT_ONE_TIMEOUT_MS = 30000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

/** Suffixes shared by block "families" — every wood type has its own *_log, every wool its
 *  own *_wool, etc. A request for one variant should still succeed if a different variant of
 *  the same family is what's actually nearby (e.g. "oak_log" when only dark oak exists).
 *  NOTE: `_ore` is deliberately NOT here — ores of different materials are NOT interchangeable
 *  (diamond_ore != gold_ore), so they get their own same-material-only matching below. */
const FAMILY_SUFFIXES = [
  '_log', '_wood', '_planks', '_leaves', '_sapling', '_stairs', '_slab', '_fence',
  '_fence_gate', '_door', '_trapdoor', '_button', '_pressure_plate', '_wool', '_carpet',
  '_concrete', '_terracotta', '_stained_glass', '_bed',
];

export function familyIdsFor(blockType: string, blocksByName: Record<string, { id: number }>): number[] {
  if (blockType.endsWith('_ore')) {
    // Ores must only match the SAME material — never substitute gold_ore for a diamond_ore
    // request. The only legitimate "family" is one material's variants across stone/deepslate/
    // nether (e.g. diamond_ore + deepslate_diamond_ore), which all drop the same resource.
    const material = blockType.replace(/^(deepslate|nether)_/, '').replace(/_ore$/, '');
    const re = new RegExp(`^(deepslate_|nether_)?${material}_ore$`);
    return Object.entries(blocksByName)
      .filter(([name]) => re.test(name))
      .map(([, b]) => b.id);
  }
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
        wideSearch: {
          type: 'boolean',
          description:
            'If true (default), roam beyond the immediate area to find the block. If false, ' +
            'only collect what is already within render range and fail fast if none is loaded.',
        },
      },
      required: ['blockType'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const blockType = String(args.blockType ?? '').toLowerCase();
    const count = clampInt(args.count, 1, 64, 1);
    const wideSearch = args.wideSearch !== false;

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
      if (!wideSearch) {
        return { ok: false, message: `No ${blockType} within render range, and wide search is off.` };
      }
      await searchOutward(bot, isNearby, ctx.reflex, ctx.shouldStop);
    }

    const collector = (
      bot as unknown as { collectBlock: { collect(b: unknown): Promise<void>; cancelTask?(): Promise<void> | void } }
    ).collectBlock;
    const reflex = ctx.reflex;
    let collected = 0;
    let failures = 0;
    let actualName = blockType;
    // Positions that timed out or errored — skip past them on the next pass instead of
    // re-targeting the same unreachable block over and over until the failure cap gives up
    // on the whole job (one truly stuck log shouldn't sink a "collect 64" request).
    const skip = new Set<string>();
    while (collected < count && failures < 3 && !ctx.shouldStop?.()) {
      // If the reflex layer is fleeing/fighting, let it finish before we mine again,
      // rather than aborting the whole gather job after a scrap.
      if (reflex?.isBusy()) {
        await sleep(300);
        continue;
      }
      let positions = exactId !== undefined ? bot.findBlocks({ matching: exactId, maxDistance: 48, count: 10 }) : [];
      if (positions.every((p) => skip.has(key(p))) && familyIds.length) {
        positions = positions.concat(bot.findBlocks({ matching: familyIds, maxDistance: 48, count: 10 }));
      }
      const pos = positions.find((p) => !skip.has(key(p)));
      if (!pos) break;
      const block = bot.blockAt(pos);
      if (!block) {
        skip.add(key(pos));
        continue;
      }
      actualName = block.name;
      try {
        // Equip the fastest tool we own first, so breaking finishes quickly.
        await equipBestToolForBlock(bot, block);
        await withTimeout(collector.collect(block), COLLECT_ONE_TIMEOUT_MS);
        collected += 1;
        failures = 0;
      } catch (err) {
        // Interrupted (often by reflex combat). Wait it out and retry instead of giving up.
        if (reflex?.isBusy()) {
          await sleep(300);
          continue;
        }
        if (err instanceof TimeoutError) {
          // The collect attempt is still running pathfinder/dig in the background — actually
          // stop it before moving on, or it keeps fighting our next target underneath us.
          try {
            await collector.cancelTask?.();
          } catch {
            /* ignore */
          }
        }
        skip.add(key(pos));
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
