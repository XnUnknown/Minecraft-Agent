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
    const items = bot.inventory.items();
    // Exact name always wins — otherwise "diamond" would match "diamond_pickaxe"/"diamond_sword"
    // via substring and drop the wrong thing. Only fall back to a partial match when there is no
    // exact one, and prefer the shortest matching name (closest to the plain item, not a variant).
    let item = items.find((i) => i.name === name);
    if (!item) {
      item = items
        .filter((i) => i.name.includes(name))
        .sort((a, b) => a.name.length - b.name.length)[0];
    }
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
