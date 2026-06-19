import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Bot } from 'mineflayer';
import type { Recipe } from 'prismarine-recipe';
import { logger } from '../util/logger';

const FILE_PATH = 'data/crafting_experience.md';
const HEADER =
  '# Crafting experience\n\n' +
  'Recipes the agent has actually crafted successfully, learned at runtime so it stops\n' +
  'guessing ingredient quantities. Stand-in for the planned RAG/vector memory system —\n' +
  'once that exists, this file gets ingested once and the raw injection below can stop.\n';

let known: Set<string> | null = null;
let cachedBody = '';

function ensureLoaded(): void {
  if (known) return;
  known = new Set();
  if (!existsSync(FILE_PATH)) {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    writeFileSync(FILE_PATH, HEADER, 'utf8');
    cachedBody = HEADER;
    return;
  }
  cachedBody = readFileSync(FILE_PATH, 'utf8');
  for (const m of cachedBody.matchAll(/^## (.+)$/gm)) known.add(m[1].trim());
}

/** Raw file content for prompt injection, or '' if nothing's been learned yet. */
export function contextBlock(): string {
  ensureLoaded();
  return cachedBody.trim() === HEADER.trim() ? '' : cachedBody.trim();
}

/** Records a newly-learned recipe (no-op if `itemName` is already documented). */
export function recordCraftSuccess(bot: Bot, itemName: string, recipe: Recipe): void {
  ensureLoaded();
  if (known!.has(itemName)) return;

  const ingredients: string[] = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const name = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
    ingredients.push(`${-d.count}x ${name}`);
  }

  const section =
    `\n## ${itemName}\n` +
    `- Ingredients per craft: ${ingredients.join(', ') || 'none'}\n` +
    `- Yields per craft: ${recipe.result.count}x ${itemName}\n` +
    `- Requires crafting table: ${recipe.requiresTable ? 'yes' : 'no'}\n`;

  cachedBody += section;
  known!.add(itemName);
  try {
    writeFileSync(FILE_PATH, cachedBody, 'utf8');
  } catch (err) {
    logger.warn(`Failed to persist crafting experience: ${err instanceof Error ? err.message : String(err)}`);
  }
}
