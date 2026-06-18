import type { Skill } from '../types';
import { clampInt } from '../util';
import { equipBestToolForBlock } from '../../util/equip';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const collectBlock: Skill = {
  def: {
    name: 'collectBlock',
    description:
      'Find and harvest nearby blocks of a type, then pick up the drops. Examples: oak_log (wood), birch_log, stone, coal_ore, iron_ore, dirt.',
    parameters: {
      type: 'object',
      properties: {
        blockType: {
          type: 'string',
          description: 'Block name to collect, e.g. oak_log, birch_log, stone, coal_ore.',
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

    const blockData = (bot.registry as unknown as { blocksByName?: Record<string, { id: number }> }).blocksByName?.[
      blockType
    ];
    if (!blockData) return `I don't know a block called "${blockType}".`;

    const collector = (bot as unknown as { collectBlock: { collect(b: unknown): Promise<void> } }).collectBlock;
    const reflex = ctx.reflex;
    let collected = 0;
    let failures = 0;
    while (collected < count && failures < 3 && !ctx.shouldStop?.()) {
      // If the reflex layer is fleeing/fighting, let it finish before we mine again,
      // rather than aborting the whole gather job after a scrap.
      if (reflex?.isBusy()) {
        await sleep(300);
        continue;
      }
      const positions = bot.findBlocks({ matching: blockData.id, maxDistance: 48, count: 1 });
      if (!positions.length) break;
      const block = bot.blockAt(positions[0]);
      if (!block) break;
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

    if (collected === 0) return `Couldn't collect any ${blockType} (none reachable nearby).`;
    return `Collected ${collected}x ${blockType}.`;
  },
};
