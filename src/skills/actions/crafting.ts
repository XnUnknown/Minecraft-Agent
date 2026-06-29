import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import type { Skill, SkillContext, SkillResult } from '../types';
import { clampInt, withTimeout } from '../util';
import { recordCraftSuccess } from '../../knowledge/CraftingExperience';
import { searchOutward, walkToward } from '../../util/navigate';
import { placeNear } from '../../util/building';
import { equipBestToolForBlock } from '../../util/equip';
import { collectBlock } from './gathering';
import { logger } from '../../util/logger';

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
        wideSearch: {
          type: 'boolean',
          description:
            'If true (default), roam beyond the immediate area to gather any missing raw ' +
            'materials and to find/make a crafting table. If false, only use materials and ' +
            'blocks already within render range and report what was missing instead.',
        },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const itemName = String(args.item ?? '').toLowerCase();
    const count = clampInt(args.count, 1, 64, 1);
    const wideSearch = args.wideSearch !== false;
    const session: TableSession = { table: null, placedByUs: false };

    logger.info(`[craft] REQUEST craft ${count}x ${itemName} (wideSearch=${wideSearch})`);
    logger.info(`[craft] inventory at start: ${inventorySummary(bot)}`);

    const result = await resolveAndCraft(bot, itemName, count, ctx, 0, session, wideSearch);
    logger.info(`[craft] RESULT (${result.ok ? 'OK' : 'FAILED'}): ${result.message}`);

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
      'right now from current inventory. With "item", reports its direct ingredients, yield, ' +
      'table requirement, AND the full recursive list of raw base materials it ultimately ' +
      'needs (expanding every craftable intermediate down to logs/ores/etc.) plus how many ' +
      'of each you still need — check this before guessing at ingredients or quantities.',
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

    // Full recursive base-material breakdown — the EXACT raw resources this ultimately bottoms
    // out in, all the way down (quantities only, not an inventory-dependent shortfall).
    const raw = new Map<string, number>();
    rawRequirements(bot, itemName, 1, table, 0, raw);
    const rawParts = [...raw.entries()].map(([name, need]) => `${need}x ${name}`);
    const rawNote = rawParts.length ? ` Raw base materials: ${rawParts.join(' + ')}.` : '';

    const craftableNow = bot.recipesFor(itemData.id, null, 1, table).length > 0;
    return { ok: true, message: `${base}${rawNote} ${craftableNow ? 'Craftable right now.' : 'Not craftable from current inventory yet.'}` };
  },
};

/**
 * Recursively expands `itemName` into the raw (un-craftable) resources it ultimately needs,
 * accounting for each recipe's yield, accumulating totals into `into`. Bottoms out on items
 * with no recipe (raw/world resources). Depth-capped so an oddly self-referential recipe
 * can't recurse forever — it just records that item as raw at the cap.
 */
function rawRequirements(
  bot: Bot,
  itemName: string,
  count: number,
  table: Block | null,
  depth: number,
  into: Map<string, number>,
): void {
  const add = (): void => {
    into.set(itemName, (into.get(itemName) ?? 0) + count);
  };
  if (depth > 6) return add();
  const itemData = bot.registry.itemsByName[itemName];
  if (!itemData) return add();
  const recipe = bot.recipesAll(itemData.id, null, table ?? true)[0];
  if (!recipe) return add();
  const craftCount = Math.ceil(count / recipe.result.count);
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const name = bot.registry.items[d.id]?.name;
    if (!name) continue;
    rawRequirements(bot, name, -d.count * craftCount, table, depth + 1, into);
  }
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

/** Cheap by default (nearby check only); only searches wide / auto-crafts one when `required`. */
async function getTable(
  bot: Bot,
  ctx: SkillContext,
  depth: number,
  notes: string[],
  required: boolean,
  session: TableSession,
  wideSearch: boolean,
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
  return findOrMakeTable(bot, ctx, depth, notes, session, wideSearch);
}

/** Searches further afield for an existing table, then crafts + places our own as a last resort. */
async function findOrMakeTable(
  bot: Bot,
  ctx: SkillContext,
  depth: number,
  notes: string[],
  session: TableSession,
  wideSearch: boolean,
): Promise<Block | null> {
  if (ctx.shouldStop?.()) return null;
  // Only roam looking for an existing table when wide search is allowed; otherwise stick to
  // what's already in render range (we may still craft + place our own below).
  logger.info(`[craft] no crafting table in reach; ${wideSearch ? 'searching wider for one' : 'wide search off, will try to make one'}.`);
  if (wideSearch) await searchOutward(bot, () => !!nearbyTable(bot), ctx.reflex, ctx.shouldStop);
  const found = nearbyTable(bot);
  if (found) {
    logger.info(`[craft] found existing crafting table @${vecStr(found.position)}.`);
    session.table = found;
    return found;
  }
  if (depth >= MAX_DEPTH || ctx.shouldStop?.()) return null;

  logger.info('[craft] no table found — crafting a new crafting_table (this consumes 4 planks).');
  const made = await resolveAndCraft(bot, TABLE_NAME, 1, ctx, depth + 1, session, wideSearch);
  notes.push(made.message);
  if (!made.ok) {
    logger.warn(`[craft] couldn't make a crafting table: ${made.message}`);
    return null;
  }

  const placed = await placeNear(bot, TABLE_NAME);
  if (!placed) {
    logger.warn('[craft] made a crafting table but found nowhere to place it.');
    notes.push("Made a crafting table but couldn't find a spot to place it.");
    return null;
  }
  const table = nearbyTable(bot);
  if (table) {
    logger.info(`[craft] placed our own crafting table @${vecStr(table.position)}.`);
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

  // The real cause of spurious "missing ingredient" on Paper servers (window/inventory slot
  // desync) is fixed in mineflayer itself via patches/mineflayer+4.37.1.patch. We still walk
  // right up to the table and face it before crafting as plain good hygiene — it keeps the
  // window open reliably and avoids edge-of-reach click failures.
  if (usedTable) {
    await walkToward(bot, () => usedTable.position, 2, ctx.reflex, ctx.shouldStop);
    try {
      await bot.lookAt(usedTable.position.offset(0.5, 0.5, 0.5), true);
    } catch {
      /* ignore look failures */
    }
  }

  const tableDist = usedTable ? bot.entity.position.distanceTo(usedTable.position).toFixed(1) : 'n/a';
  logger.info(
    `[craft] doCraft ${itemName}: repeating recipe ${craftCount}x (yields ${recipe.result.count} each), ` +
      `table=${usedTable ? `@${vecStr(usedTable.position)} dist ${tableDist}m` : 'none'}; ` +
      `ingredients on hand -> ${ingredientStatus(bot, recipe, count)}`,
  );
  let lastErr: string | null = null;
  for (let i = 0; i < craftCount; i++) {
    if (ctx.shouldStop?.()) break;
    try {
      await withTimeout(bot.craft(recipe, 1, usedTable ?? undefined), 20000);
      logger.info(`[craft] doCraft ${itemName}: op ${i + 1}/${craftCount} OK.`);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // A failed table-craft leaves ingredients sitting in the crafting grid, where
      // inventory.count() reads them as 0. Close the window so they fall back into inventory
      // (otherwise a retry/replan thinks the materials are gone).
      try {
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      } catch {
        /* ignore */
      }
      logger.warn(
        `[craft] doCraft ${itemName}: op ${i + 1}/${craftCount} FAILED: ${lastErr}. ` +
          `Ingredient status now -> ${ingredientStatus(bot, recipe, count)}`,
      );
      break;
    }
  }
  const made = bot.inventory.count(recipe.result.id, recipe.result.metadata) - before;
  logger.info(`[craft] doCraft ${itemName}: made ${made} (wanted ${count}).`);

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
  wideSearch: boolean,
): Promise<SkillResult> {
  if (ctx.shouldStop?.()) return { ok: false, message: 'Cancelled.' };

  const pad = '  '.repeat(depth);
  const itemData = bot.registry.itemsByName[itemName];
  if (!itemData) return { ok: false, message: `I don't know an item called "${itemName}".` };

  const candidates = bot.recipesAll(itemData.id, null, true);
  if (!candidates.length) {
    // No recipe exists at all — it's a raw/world resource, not something we craft.
    logger.info(`[craft] ${pad}${itemName} x${count}: no recipe -> treat as raw resource, gathering it.`);
    return collectBlock.run(bot, { blockType: itemName, count, wideSearch }, ctx);
  }

  const notes: string[] = [];
  const mightNeedTable = candidates.every((r) => r.requiresTable);
  // Report exactly what this item takes and what's on hand, before we try anything.
  logger.info(
    `[craft] ${pad}resolve ${itemName} x${count} (depth ${depth}): ` +
      `${candidates.length} recipe(s), needsTable=${mightNeedTable}; ` +
      `ingredients -> ${ingredientStatus(bot, candidates[0], count)}`,
  );

  let table = await getTable(bot, ctx, depth, notes, mightNeedTable, session, wideSearch);
  let { recipe, usedTable } = pickRecipes(bot, itemData.id, count, table);

  if (!recipe && !table) {
    // Turns out we can't satisfy any recipe without one after all — now actually go get one.
    table = await getTable(bot, ctx, depth, notes, true, session, wideSearch);
    ({ recipe, usedTable } = pickRecipes(bot, itemData.id, count, table));
  }

  if (recipe) {
    logger.info(
      `[craft] ${pad}${itemName}: craftable now from inventory (table=${usedTable ? `@${vecStr(usedTable.position)}` : 'none'}). Crafting.`,
    );
    // Ingredient resolution (gathering, pre-crafting) may have walked the bot away from the
    // table — without this it can fail with a generic/misleading error simply because it's
    // not actually standing next to the table it's about to try to activate.
    if (usedTable) await walkToward(bot, () => usedTable.position, 3, ctx.reflex, ctx.shouldStop);
    return doCraft(bot, itemName, count, recipe, usedTable, notes, ctx);
  }

  const anyRecipe = bot.recipesAll(itemData.id, null, table ?? true)[0];
  if (!anyRecipe) return { ok: false, message: prefix(notes, `There's no known recipe for "${itemName}".`) };
  if (anyRecipe.requiresTable && !table) {
    logger.warn(`[craft] ${pad}${itemName}: needs a crafting table, none found or made.`);
    return { ok: false, message: prefix(notes, `Crafting ${itemName} needs a crafting table, and I couldn't find or make one.`) };
  }
  logger.info(
    `[craft] ${pad}${itemName}: not craftable yet, resolving ingredients -> ${ingredientStatus(bot, anyRecipe, count)}`,
  );
  if (depth >= MAX_DEPTH || ctx.shouldStop?.()) {
    logger.warn(`[craft] ${pad}${itemName}: stopping at depth ${depth} (cap ${MAX_DEPTH}). Requires ${describeRequirements(bot, anyRecipe, count)}.`);
    return { ok: false, message: prefix(notes, `Can't craft ${itemName} right now — it requires ${describeRequirements(bot, anyRecipe, count)}.`) };
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
    logger.info(`[craft] ${pad}-> need ${need - have} more ${ingredientName} for ${itemName} (have ${have}/${need}); resolving it.`);
    const sub = await resolveAndCraft(bot, ingredientName, need - have, ctx, depth + 1, session, wideSearch);
    logger.info(`[craft] ${pad}<- ${ingredientName}: ${sub.ok ? 'OK' : 'FAILED'} — ${sub.message}`);
    notes.push(sub.message);
  }

  if (ctx.shouldStop?.()) return { ok: false, message: prefix(notes, 'Cancelled.') };

  const retry = pickRecipes(bot, itemData.id, count, table);
  if (!retry.recipe) {
    logger.warn(
      `[craft] ${pad}${itemName}: STILL not craftable after resolving ingredients. ` +
        `Final ingredient status -> ${ingredientStatus(bot, anyRecipe, count)}`,
    );
    return { ok: false, message: prefix(notes, `Can't craft ${itemName} right now — it requires ${describeRequirements(bot, anyRecipe, count)}.`) };
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

/** Per-ingredient need-vs-have snapshot for a recipe, for diagnostic logging — shows exactly
 *  which ingredient is short (by EXACT name + metadata, so e.g. a oak_planks requirement that
 *  spruce_planks can't satisfy is obvious in the log). */
function ingredientStatus(bot: Bot, recipe: Recipe, want: number): string {
  const craftCount = Math.ceil(want / recipe.result.count);
  const parts: string[] = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const need = -d.count * craftCount;
    const have = bot.inventory.count(d.id, d.metadata);
    const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
    parts.push(`${name} need ${need} have ${have}${have < need ? ` (SHORT ${need - have})` : ' (ok)'}`);
  }
  return parts.length ? parts.join(', ') : 'no ingredients';
}

/** Compact dump of everything currently in the bot's inventory, for diagnostic logging. */
function inventorySummary(bot: Bot): string {
  const items = bot.inventory.items().map((i) => `${i.count}x ${i.name}`);
  return items.length ? items.join(', ') : '(empty)';
}

function vecStr(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

/** Lists a recipe's EXACT, full ingredient requirements (every ingredient + quantity, scaled
 *  to the requested amount) — independent of current inventory, so a craft result reports
 *  what the item actually takes to make, not an inventory-dependent shortfall. */
function describeRequirements(bot: Bot, recipe: Recipe, want: number): string {
  const craftCount = Math.ceil(want / recipe.result.count);
  const parts: string[] = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const need = -d.count * craftCount;
    const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
    parts.push(`${need}x ${name}`);
  }
  return parts.length ? parts.join(' + ') : 'no ingredients';
}
