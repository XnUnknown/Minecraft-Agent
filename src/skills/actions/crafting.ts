import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import type { Skill, SkillContext, SkillResult } from '../types';
import { clampInt, withTimeout } from '../util';
import { recordCraftSuccess } from '../../knowledge/CraftingExperience';
import { walkToward } from '../../util/navigate';
import { placeNear } from '../../util/building';
import { equipBestToolForBlock } from '../../util/equip';
import { logger } from '../../util/logger';

const TABLE_NAME = 'crafting_table';

/**
 * Craft ONE item, ONE level deep. Deliberately NOT self-healing: it does not recursively gather
 * raw materials or pre-craft missing intermediates. The model orchestrates that itself — call
 * getRecipe to see what an item needs, collect/craft those parts, then call craftItem. The only
 * convenience kept is placing a crafting_table the bot already carries (and picking it back up),
 * since that's a physical step, not requirement-resolution.
 */
export const craftItem: Skill = {
  def: {
    name: 'craftItem',
    description:
      'Craft an item ONE step from the ingredients already in your inventory. It does NOT ' +
      'gather raw materials or pre-craft sub-ingredients for you — use getRecipe to see what ' +
      'an item needs, collect/craft those parts yourself, THEN craftItem. If a crafting table ' +
      'is needed it uses a nearby one, or places one you are carrying (and picks it back up). ' +
      'Use the exact item name, e.g. stick, oak_planks, wooden_pickaxe.',
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

    const candidates = bot.recipesAll(itemData.id, null, true);
    if (!candidates.length) {
      return { ok: false, message: `"${itemName}" has no crafting recipe — it's a raw/gathered resource, not craftable.` };
    }

    logger.info(`[craft] craft ${count}x ${itemName}; inventory: ${inventorySummary(bot)}`);

    const needsTable = candidates.every((r) => r.requiresTable);
    let placedTable: Block | null = null;
    let table = nearbyTable(bot);

    if (!table && needsTable) {
      // No table in reach: place one we're carrying. We do NOT craft a table here — if the bot
      // has none, the model should craft a crafting_table first, then retry.
      placedTable = await placeOwnTable(bot);
      if (!placedTable) {
        return {
          ok: false,
          message: `Crafting ${itemName} needs a crafting table — none nearby and none in my inventory. Craft a crafting_table first, then retry.`,
        };
      }
      table = placedTable;
    }

    const { recipe, usedTable } = pickRecipes(bot, itemData.id, count, table);
    if (!recipe) {
      if (placedTable) await collectTableBack(bot, placedTable, ctx);
      const anyRecipe = candidates[0];
      const tableNote = anyRecipe.requiresTable && !table ? ' and a crafting table' : '';
      return {
        ok: false,
        message: `Can't craft ${count}x ${itemName} right now — one craft needs ${describeRecipe(bot, anyRecipe)}${tableNote}. Collect/craft those first (see getRecipe).`,
      };
    }

    const result = await doCraft(bot, itemName, count, recipe, usedTable, ctx);
    if (placedTable) {
      const cleanup = await collectTableBack(bot, placedTable, ctx);
      if (cleanup) return { ok: result.ok, message: `${result.message} ${cleanup}` };
    }
    return result;
  },
};

export const getRecipe: Skill = {
  def: {
    name: 'getRecipe',
    description:
      'Look up crafting recipes without crafting anything. With no args, lists items you can ' +
      'craft right now from your current inventory. With "item", lists ALL known recipes for ' +
      'that item — each one\'s exact ingredients, how many it yields, and whether it needs a ' +
      'crafting table — and notes which are craftable right now. Use it to figure out, level ' +
      'by level, what raw blocks you need to collect and what intermediates to craft.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Optional: a specific item to look up, e.g. wooden_pickaxe.' },
      },
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const itemName = args.item ? String(args.item).toLowerCase() : undefined;
    const table = nearbyTable(bot);

    if (!itemName) {
      const craftableNow: string[] = [];
      for (const item of Object.values(bot.registry.items) as Array<{ id: number; name: string }>) {
        if (bot.recipesFor(item.id, null, 1, table).length) {
          craftableNow.push(item.name);
          if (craftableNow.length >= 30) break;
        }
      }
      return craftableNow.length
        ? { ok: true, message: `You can craft right now: ${craftableNow.join(', ')}.` }
        : { ok: true, message: "Nothing's craftable right now with what's on hand." };
    }

    const itemData = bot.registry.itemsByName[itemName];
    if (!itemData) return { ok: false, message: `I don't know an item called "${itemName}".` };

    // ALL recipes (with a table assumed available, so table-only recipes show up too).
    const recipes = bot.recipesAll(itemData.id, null, table ?? true);
    if (!recipes.length) {
      return { ok: false, message: `There's no known recipe for "${itemName}" — it's a raw/gathered resource (mine or collect it).` };
    }

    const craftableNowIds = new Set(bot.recipesFor(itemData.id, null, 1, table).map((r) => recipeKey(r)));
    const parts: string[] = [];
    const shown = recipes.slice(0, 6);
    shown.forEach((r, i) => {
      const tableNote = r.requiresTable ? 'needs table' : 'no table';
      const now = craftableNowIds.has(recipeKey(r)) ? ', craftable now' : '';
      parts.push(`#${i + 1}: ${describeRecipe(bot, r)} -> ${r.result.count}x ${itemName} (${tableNote}${now})`);
    });
    const extra = recipes.length > shown.length ? ` (+${recipes.length - shown.length} more variant(s))` : '';
    return { ok: true, message: `Recipes for ${itemName}${extra}: ${parts.join(' | ')}.` };
  },
};

/** A stable-ish identity for a recipe, to match recipesFor results against recipesAll. */
function recipeKey(r: Recipe): string {
  return JSON.stringify(r.delta.map((d) => [d.id, d.metadata, d.count]));
}

function nearbyTable(bot: Bot): Block | null {
  const tableId = bot.registry.blocksByName[TABLE_NAME]?.id;
  return tableId !== undefined ? bot.findBlock({ matching: tableId, maxDistance: 48 }) : null;
}

function pickRecipes(
  bot: Bot,
  itemId: number,
  count: number,
  table: Block | null,
): { recipe: Recipe | null; usedTable: Block | null } {
  let recipes = bot.recipesFor(itemId, null, count, table);
  let usedTable = table;
  if (!recipes.length && table) {
    recipes = bot.recipesFor(itemId, null, count, null);
    usedTable = null;
  }
  return { recipe: recipes[0] ?? null, usedTable };
}

/** Places a crafting_table the bot is carrying near itself, returning the placed block (or null
 *  if it has none / nowhere to place). Never crafts one — that's the model's job. */
async function placeOwnTable(bot: Bot): Promise<Block | null> {
  const tableId = bot.registry.itemsByName[TABLE_NAME]?.id;
  if (tableId === undefined || bot.inventory.count(tableId, null) <= 0) return null;
  const placed = await placeNear(bot, TABLE_NAME);
  if (!placed) {
    logger.warn('[craft] have a crafting_table but found nowhere to place it.');
    return null;
  }
  const table = nearbyTable(bot);
  if (table) logger.info(`[craft] placed my own crafting table @${vecStr(table.position)}.`);
  return table;
}

async function doCraft(
  bot: Bot,
  itemName: string,
  count: number,
  recipe: Recipe,
  usedTable: Block | null,
  ctx: SkillContext,
): Promise<SkillResult> {
  // bot.craft()'s count means "times to repeat the recipe", each repeat yields result.count.
  const craftCount = Math.ceil(count / recipe.result.count);
  const before = bot.inventory.count(recipe.result.id, recipe.result.metadata);

  if (usedTable) {
    await walkToward(bot, () => usedTable.position, 2, ctx.reflex, ctx.shouldStop);
    try {
      await bot.lookAt(usedTable.position.offset(0.5, 0.5, 0.5), true);
    } catch {
      /* ignore look failures */
    }
  }

  let lastErr: string | null = null;
  for (let i = 0; i < craftCount; i++) {
    if (ctx.shouldStop?.()) break;
    try {
      await withTimeout(bot.craft(recipe, 1, usedTable ?? undefined), 20000);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      try {
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      } catch {
        /* ignore */
      }
      logger.warn(`[craft] ${itemName}: craft op ${i + 1}/${craftCount} failed: ${lastErr}`);
      break;
    }
  }

  const made = bot.inventory.count(recipe.result.id, recipe.result.metadata) - before;
  logger.info(`[craft] ${itemName}: made ${made} (wanted ${count}).`);
  if (made <= 0) {
    return { ok: false, message: lastErr ? `Couldn't craft ${itemName}: ${lastErr}` : `Couldn't craft ${itemName}.` };
  }
  recordCraftSuccess(bot, itemName, recipe);
  if (made < count) {
    return { ok: true, message: `Crafted ${made}x ${itemName} (wanted ${count})${lastErr ? ` — ran out partway (${lastErr}).` : '.'}` };
  }
  return { ok: true, message: `Crafted ${made}x ${itemName}.` };
}

/** Mines a table we placed ourselves back up so it doesn't litter the world. */
async function collectTableBack(bot: Bot, table: Block, ctx: SkillContext): Promise<string> {
  if (ctx.shouldStop?.()) return '';
  const pos = table.position;
  if (bot.blockAt(pos)?.name !== TABLE_NAME) return '';
  try {
    await walkToward(bot, () => pos, 3, ctx.reflex, ctx.shouldStop);
    const block = bot.blockAt(pos);
    if (block?.name !== TABLE_NAME) return '';
    await equipBestToolForBlock(bot, block);
    await bot.dig(block);
    return 'Picked the crafting table back up.';
  } catch {
    return '';
  }
}

/** Lists a recipe's exact ingredients (count x name), independent of current inventory. */
function describeRecipe(bot: Bot, recipe: Recipe): string {
  const parts: string[] = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
    parts.push(`${-d.count}x ${name}`);
  }
  return parts.length ? parts.join(' + ') : 'no ingredients';
}

function inventorySummary(bot: Bot): string {
  const items = bot.inventory.items().map((i) => `${i.count}x ${i.name}`);
  return items.length ? items.join(', ') : '(empty)';
}

function vecStr(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}
