import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';

/** Material tiers, worst -> best, used to rank tools/weapons we already hold. */
const TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

function tierRank(name: string): number {
  for (let i = 0; i < TIER.length; i++) if (name.startsWith(`${TIER[i]}_`)) return i;
  return -1;
}

/**
 * Equip the best tool we own for mining a given block (uses the mineflayer-tool plugin,
 * which accounts for harvest level and dig speed). Falls back silently if unavailable.
 * Equipping the correct tool is what makes breaking finish quickly instead of dragging on.
 */
export async function equipBestToolForBlock(bot: Bot, block: Block): Promise<void> {
  const tool = (bot as unknown as {
    tool?: { equipForBlock(b: Block, opts: object): Promise<void> };
  }).tool;
  if (!tool) return;
  try {
    await tool.equipForBlock(block, { requireHarvest: false, getFromChest: false });
  } catch {
    /* no better tool / can't equip — mine with whatever is in hand */
  }
}

/**
 * Equip the best melee weapon we own (prefers swords, then axes, by material tier).
 * Returns the equipped item name, or null if we have nothing better than fists.
 */
export async function equipBestWeapon(bot: Bot): Promise<string | null> {
  const items = bot.inventory.items();
  const score = (it: Item): number => {
    const isSword = it.name.endsWith('_sword');
    const isAxe = it.name.endsWith('_axe');
    if (!isSword && !isAxe) return -1;
    const tier = tierRank(it.name);
    if (tier < 0) return -1;
    // Swords beat axes of the same tier for sustained DPS; weight tier heavily.
    return tier * 2 + (isSword ? 1 : 0);
  };

  let best: Item | null = null;
  let bestScore = -1;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) {
      best = it;
      bestScore = s;
    }
  }
  if (!best) return null;
  if (bot.heldItem?.name === best.name) return best.name;
  try {
    await bot.equip(best, 'hand');
    return best.name;
  } catch {
    return bot.heldItem?.name ?? null;
  }
}
