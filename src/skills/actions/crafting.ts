import type { Bot } from 'mineflayer';
import type { Recipe } from 'prismarine-recipe';
import type { Skill } from '../types';
import { clampInt } from '../util';
import { recordCraftSuccess } from '../../knowledge/CraftingExperience';

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
  async run(bot, args, ctx) {
    const itemName = String(args.item ?? '').toLowerCase();
    const count = clampInt(args.count, 1, 64, 1);

    const itemData = bot.registry.itemsByName[itemName];
    if (!itemData) return { ok: false, message: `I don't know an item called "${itemName}".` };

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
      if (!anyRecipe) return { ok: false, message: `There's no known recipe for "${itemName}".` };
      if (anyRecipe.requiresTable && !table) {
        return {
          ok: false,
          message: `Crafting ${itemName} needs a crafting table, and there isn't one within 32 blocks.`,
        };
      }
      return {
        ok: false,
        message: `Can't craft ${itemName} yet — missing ${describeMissing(bot, anyRecipe, count)}.`,
      };
    }

    const recipe = recipes[0];
    // bot.craft()'s count argument means "how many times to repeat the recipe", NOT "how many
    // output items we want" — each repeat yields recipe.result.count items, so convert first.
    // (Passing the raw item count here was the original bug: requesting e.g. 16 fences meant
    // attempting 16 craft operations, needing 4x the actual material, instead of the 6 needed.)
    const craftCount = Math.ceil(count / recipe.result.count);
    const before = bot.inventory.count(recipe.result.id, recipe.result.metadata);
    let lastErr: string | null = null;
    for (let i = 0; i < craftCount; i++) {
      if (ctx.shouldStop?.()) break;
      try {
        await bot.craft(recipe, 1, usedTable ?? undefined);
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    const made = bot.inventory.count(recipe.result.id, recipe.result.metadata) - before;

    if (made <= 0) {
      return {
        ok: false,
        message: lastErr ? `Couldn't craft ${itemName}: ${lastErr}` : `Couldn't craft ${itemName}.`,
      };
    }
    recordCraftSuccess(bot, itemName, recipe);
    if (made < count) {
      return {
        ok: true,
        message:
          `Crafted ${made}x ${itemName} (wanted ${count})` +
          (lastErr ? ` — ran out partway (${lastErr}).` : '.'),
      };
    }
    return { ok: true, message: `Crafted ${made}x ${itemName}.` };
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
