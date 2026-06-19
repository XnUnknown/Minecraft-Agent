import type { Bot } from 'mineflayer';
import type { Recipe } from 'prismarine-recipe';
import type { Skill } from '../types';
import { clampInt } from '../util';

const TABLE_NAME = 'crafting_table';

export const craftItem: Skill = {
  def: {
    name: 'craftItem',
    description:
      'Craft an item from a recipe using inventory materials. Uses a nearby crafting table ' +
      '(walks within 32 blocks of one automatically) for 3x3 recipes, or the 2x2 inventory grid ' +
      'for simple ones. Use the exact item name, e.g. crafting_table, stick, wooden_pickaxe.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item to craft, e.g. stick, torch, wooden_pickaxe.' },
        count: { type: 'integer', description: 'How many to craft (default 1).' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const itemName = String(args.item ?? '').toLowerCase();
    const count = clampInt(args.count, 1, 64, 1);

    const itemData = bot.registry.itemsByName[itemName];
    if (!itemData) return `I don't know an item called "${itemName}".`;

    const tableId = bot.registry.blocksByName[TABLE_NAME]?.id;
    const table = tableId !== undefined ? bot.findBlock({ matching: tableId, maxDistance: 32 }) : null;

    let recipes = bot.recipesFor(itemData.id, null, count, table);
    let usedTable = table;
    if (!recipes.length && table) {
      // Some recipes don't need a table at all — retry without one before giving up.
      recipes = bot.recipesFor(itemData.id, null, count, null);
      usedTable = null;
    }
    if (!recipes.length) {
      const anyRecipe = bot.recipesAll(itemData.id, null, table)[0];
      if (!anyRecipe) return `There's no known recipe for "${itemName}".`;
      if (anyRecipe.requiresTable && !table) {
        return `Crafting ${itemName} needs a crafting table, and there isn't one within 32 blocks.`;
      }
      return `Can't craft ${itemName} yet — missing ${describeMissing(bot, anyRecipe, count)}.`;
    }

    const recipe = recipes[0];
    try {
      await bot.craft(recipe, count, usedTable ?? undefined);
    } catch (err) {
      return `Couldn't craft ${itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `Crafted ${count}x ${itemName}.`;
  },
};

/** Names what's still missing for a recipe, so a failed craft is actionable, not just "no". */
function describeMissing(bot: Bot, recipe: Recipe, want: number): string {
  const craftCount = Math.ceil(want / recipe.result.count);
  const parts: string[] = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const need = -d.count * craftCount;
    const have = bot.inventory.count(d.id, d.metadata);
    if (have < need) {
      const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
      parts.push(`${need - have}x ${name}`);
    }
  }
  return parts.length ? parts.join(', ') : 'ingredients I do not have';
}
