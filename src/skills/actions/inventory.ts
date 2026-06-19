import type { Skill } from '../types';
import { clampInt } from '../util';

export const tossItem: Skill = {
  def: {
    name: 'tossItem',
    description:
      'Drop items from inventory onto the ground — e.g. to hand items to a player you are standing next to ("bring me wood").',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item name to drop, e.g. oak_log.' },
        count: { type: 'integer', description: 'How many to drop (default: all of that item).' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const name = String(args.item ?? '').toLowerCase();
    const item = bot.inventory.items().find((i) => i.name === name || i.name.includes(name));
    if (!item) return { ok: false, message: `I don't have any ${name}.` };

    const count = clampInt(args.count, 1, item.count, item.count);
    try {
      await bot.toss(item.type, null, count);
    } catch (err) {
      return { ok: false, message: `Couldn't drop ${item.name}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, message: `Dropped ${count}x ${item.name}.` };
  },
};
