import type { EquipmentDestination } from 'mineflayer';
import type { Skill } from '../types';

const SLOT_BY_SUFFIX: Array<[string, EquipmentDestination]> = [
  ['_helmet', 'head'],
  ['_chestplate', 'torso'],
  ['_leggings', 'legs'],
  ['_boots', 'feet'],
];

/** Picks the armor/offhand slot an item belongs in; anything else is held in the main hand. */
function destinationFor(name: string): EquipmentDestination {
  if (name === 'elytra') return 'torso';
  if (name === 'shield') return 'off-hand';
  for (const [suffix, dest] of SLOT_BY_SUFFIX) {
    if (name.endsWith(suffix)) return dest;
  }
  return 'hand';
}

export const wearItem: Skill = {
  def: {
    name: 'wearItem',
    description:
      'Equip armor, a shield, or a held item from inventory to its correct slot automatically ' +
      '(helmets/chestplates/leggings/boots/elytra/shield go to their armor slot; anything else goes ' +
      'to hand). Use for "wear/put on/equip X".',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item to equip, e.g. iron_chestplate, shield, diamond_sword.' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const name = String(args.item ?? '').toLowerCase();
    const item = bot.inventory.items().find((i) => i.name === name || i.name.includes(name));
    if (!item) return `I don't have any ${name} to wear.`;

    const destination = destinationFor(item.name);
    try {
      await bot.equip(item, destination);
    } catch (err) {
      return `Couldn't equip ${item.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `Equipped ${item.name}.`;
  },
};
