import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import type { Skill, SkillContext, SkillResult } from '../types';
import { clampInt } from '../util';
import { recordCraftSuccess } from '../../knowledge/CraftingExperience';
import { searchOutward, walkToward } from '../../util/navigate';
import { placeNear } from '../../util/building';
import { equipBestToolForBlock } from '../../util/equip';
import { collectBlock } from './gathering';

const TABLE_NAME = 'crafting_table';
/** Caps how many ingredient levels we'll auto-resolve (log -> planks -> stick -> tool is 3
 *  hops) so a genuinely unreachable item fails promptly instead of spiralling. */
const MAX_DEPTH = 3;

/**
 * Tracks the ONE crafting table a whole craftItem call settles on, shared across every
 * recursive pre-craft so they reuse it instead of each independently searching/placing —
 * and so the top level knows whether to collect it back up once everything is done.
 */
interface TableSession {
  table: Block | null;
  placedByUs: boolean;
}

export const craftItem: Skill = {
  def: {
    name: 'craftItem',
    description:
      'Craft an item from a recipe. Self-healing: if a crafting table is needed and none is ' +
      'nearby, it searches further and crafts+places its own; if an ingredient is short, it ' +
      'pre-crafts it from on-hand materials (e.g. planks from logs) or gathers it from the ' +
      'world, then retries — you usually only need to call this once per final item, not ' +
      'every intermediate step. Use the exact item name, e.g. crafting_table, stick, ' +
      'wooden_pickaxe.',
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
    const session: TableSession = { table: null, placedByUs: false };

    const result = await resolveAndCraft(bot, itemName, count, ctx, 0, session);

    if (session.placedByUs) {
      const cleanup = await collectTableBack(bot, session, ctx);
      if (cleanup) return { ok: result.ok, message: `${result.message} ${cleanup}` };
    }
    return result;
  },
};

export const getRecipe: Skill = {
  def: {
    name: 'getRecipe',
    description:
      'Check crafting recipes without crafting anything. With no args, lists items craftable ' +
      'right now from current inventory. With "item", reports its ingredients, yield, table ' +
      'requirement, and exactly what is missing if it cannot be crafted yet — check this ' +
      'before guessing at ingredient names or quantities.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Optional: a specific item to look up, e.g. stick.' },
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
          if (craftableNow.length >= 25) break;
        }
      }
      return craftableNow.length
        ? { ok: true, message: `You can craft right now: ${craftableNow.join(', ')}.` }
        : { ok: true, message: "Nothing's craftable right now with what's on hand." };
    }

    const itemData = bot.registry.itemsByName[itemName];
    if (!itemData) return { ok: false, message: `I don't know an item called "${itemName}".` };

    const recipe = bot.recipesAll(itemData.id, null, table ?? true)[0];
    if (!recipe) {
      return { ok: false, message: `There's no known recipe for "${itemName}" — it's probably a raw/world resource.` };
    }

    const ingredients: string[] = [];
    for (const d of recipe.delta) {
      if (d.count >= 0) continue;
      const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
      ingredients.push(`${-d.count}x ${name}`);
    }
    const tableNote = recipe.requiresTable ? 'needs a crafting table' : 'no table needed';
    const base = `${itemName}: ${ingredients.join(' + ') || 'no ingredients'} -> ${recipe.result.count}x ${itemName} (${tableNote}).`;

    const craftableNow = bot.recipesFor(itemData.id, null, 1, table).length > 0;
    return craftableNow
      ? { ok: true, message: `${base} Craftable right now.` }
      : { ok: true, message: `${base} Missing ${describeMissing(bot, recipe, 1)}.` };
  },
};

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

/** Cheap by default (nearby check only); only searches wide / auto-crafts one when `required`. */
async function getTable(
  bot: Bot,
  ctx: SkillContext,
  depth: number,
  notes: string[],
  required: boolean,
  session: TableSession,
): Promise<Block | null> {
  // Reuse the table this job already secured, if it's still actually there.
  if (session.table) {
    const stillThere = bot.blockAt(session.table.position);
    if (stillThere?.name === TABLE_NAME) return stillThere;
    session.table = null;
    session.placedByUs = false;
  }

  const cheap = nearbyTable(bot);
  if (cheap) {
    session.table = cheap;
    return cheap;
  }
  if (!required) return null;
  return findOrMakeTable(bot, ctx, depth, notes, session);
}

/** Searches further afield for an existing table, then crafts + places our own as a last resort. */
async function findOrMakeTable(
  bot: Bot,
  ctx: SkillContext,
  depth: number,
  notes: string[],
  session: TableSession,
): Promise<Block | null> {
  if (ctx.shouldStop?.()) return null;
  await searchOutward(bot, () => !!nearbyTable(bot), ctx.reflex, ctx.shouldStop);
  const found = nearbyTable(bot);
  if (found) {
    session.table = found;
    return found;
  }
  if (depth >= MAX_DEPTH || ctx.shouldStop?.()) return null;

  const made = await resolveAndCraft(bot, TABLE_NAME, 1, ctx, depth + 1, session);
  notes.push(made.message);
  if (!made.ok) return null;

  const placed = await placeNear(bot, TABLE_NAME);
  if (!placed) {
    notes.push("Made a crafting table but couldn't find a spot to place it.");
    return null;
  }
  const table = nearbyTable(bot);
  if (table) {
    session.table = table;
    session.placedByUs = true;
  }
  return table;
}

async function doCraft(
  bot: Bot,
  itemName: string,
  count: number,
  recipe: Recipe,
  usedTable: Block | null,
  notes: string[],
  ctx: SkillContext,
): Promise<SkillResult> {
  // bot.craft()'s count argument means "how many times to repeat the recipe", NOT "how many
  // output items we want" — each repeat yields recipe.result.count items, so convert first.
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
    return { ok: false, message: prefix(notes, lastErr ? `Couldn't craft ${itemName}: ${lastErr}` : `Couldn't craft ${itemName}.`) };
  }
  recordCraftSuccess(bot, itemName, recipe);
  if (made < count) {
    return {
      ok: true,
      message: prefix(notes, `Crafted ${made}x ${itemName} (wanted ${count})` + (lastErr ? ` — ran out partway (${lastErr}).` : '.')),
    };
  }
  return { ok: true, message: prefix(notes, `Crafted ${made}x ${itemName}.`) };
}

/**
 * Makes sure `itemName` x `count` exists, recursively pre-crafting missing intermediate
 * ingredients from on-hand materials and gathering missing raw blocks from the world
 * (via the existing `collectBlock`) before retrying — instead of failing the moment
 * something's short. Depth-capped (see MAX_DEPTH) so a genuinely unreachable item fails
 * promptly rather than spiralling.
 */
async function resolveAndCraft(
  bot: Bot,
  itemName: string,
  count: number,
  ctx: SkillContext,
  depth: number,
  session: TableSession,
): Promise<SkillResult> {
  if (ctx.shouldStop?.()) return { ok: false, message: 'Cancelled.' };

  const itemData = bot.registry.itemsByName[itemName];
  if (!itemData) return { ok: false, message: `I don't know an item called "${itemName}".` };

  const candidates = bot.recipesAll(itemData.id, null, true);
  if (!candidates.length) {
    // No recipe exists at all — it's a raw/world resource, not something we craft.
    return collectBlock.run(bot, { blockType: itemName, count }, ctx);
  }

  const notes: string[] = [];
  const mightNeedTable = candidates.every((r) => r.requiresTable);
  let table = await getTable(bot, ctx, depth, notes, mightNeedTable, session);
  let { recipe, usedTable } = pickRecipes(bot, itemData.id, count, table);

  if (!recipe && !table) {
    // Turns out we can't satisfy any recipe without one after all — now actually go get one.
    table = await getTable(bot, ctx, depth, notes, true, session);
    ({ recipe, usedTable } = pickRecipes(bot, itemData.id, count, table));
  }

  if (recipe) {
    // Ingredient resolution (gathering, pre-crafting) may have walked the bot away from the
    // table — without this it can fail with a generic/misleading error simply because it's
    // not actually standing next to the table it's about to try to activate.
    if (usedTable) await walkToward(bot, () => usedTable.position, 3, ctx.reflex, ctx.shouldStop);
    return doCraft(bot, itemName, count, recipe, usedTable, notes, ctx);
  }

  const anyRecipe = bot.recipesAll(itemData.id, null, table ?? true)[0];
  if (!anyRecipe) return { ok: false, message: prefix(notes, `There's no known recipe for "${itemName}".`) };
  if (anyRecipe.requiresTable && !table) {
    return { ok: false, message: prefix(notes, `Crafting ${itemName} needs a crafting table, and I couldn't find or make one.`) };
  }
  if (depth >= MAX_DEPTH || ctx.shouldStop?.()) {
    return { ok: false, message: prefix(notes, `Can't craft ${itemName} yet — missing ${describeMissing(bot, anyRecipe, count)}.`) };
  }

  const craftCount = Math.ceil(count / anyRecipe.result.count);
  for (const d of anyRecipe.delta) {
    if (d.count >= 0) continue;
    // A stop request must actually stop the resolution chain here, not just skip this one
    // ingredient — `continue` would still fall through to crafting below once the loop ends.
    if (ctx.shouldStop?.()) break;
    const need = -d.count * craftCount;
    const have = bot.inventory.count(d.id, d.metadata);
    if (have >= need) continue;
    const ingredientName = bot.registry.items[d.id]?.name;
    if (!ingredientName) continue;
    const sub = await resolveAndCraft(bot, ingredientName, need - have, ctx, depth + 1, session);
    notes.push(sub.message);
  }

  if (ctx.shouldStop?.()) return { ok: false, message: prefix(notes, 'Cancelled.') };

  const retry = pickRecipes(bot, itemData.id, count, table);
  if (!retry.recipe) {
    return { ok: false, message: prefix(notes, `Can't craft ${itemName} yet — missing ${describeMissing(bot, anyRecipe, count)}.`) };
  }
  // Same reasoning as above: gathering ingredients just now may have moved the bot off the table.
  if (retry.usedTable) await walkToward(bot, () => retry.usedTable!.position, 3, ctx.reflex, ctx.shouldStop);
  return doCraft(bot, itemName, count, retry.recipe, retry.usedTable, notes, ctx);
}

function prefix(notes: string[], message: string): string {
  return notes.length ? `${notes.join(' ')} ${message}` : message;
}

/** Mines the table we placed ourselves back up once the whole job is done, so it doesn't
 *  litter the world and the bot keeps carrying it for next time. Skipped if cancelled. */
async function collectTableBack(bot: Bot, session: TableSession, ctx: SkillContext): Promise<string> {
  if (ctx.shouldStop?.() || !session.table) return '';
  const pos = session.table.position;
  const current = bot.blockAt(pos);
  if (current?.name !== TABLE_NAME) return '';

  try {
    await walkToward(bot, () => pos, 3, ctx.reflex, ctx.shouldStop);
    if (ctx.shouldStop?.()) return '';
    const block = bot.blockAt(pos);
    if (block?.name !== TABLE_NAME) return '';
    await equipBestToolForBlock(bot, block);
    await bot.dig(block);
    return 'Picked the crafting table back up.';
  } catch {
    return '';
  }
}

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
