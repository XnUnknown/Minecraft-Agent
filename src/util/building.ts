import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

/**
 * Places a held item from inventory on the ground next to the bot (e.g. a crafting table
 * it just made). Tries the 4 cardinal foot-level neighbors for a solid block to place
 * against with clear space above; returns false if none of them work.
 */
export async function placeNear(bot: Bot, itemName: string): Promise<boolean> {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return false;

  try {
    await bot.equip(item, 'hand');
  } catch {
    return false;
  }

  const feet = bot.entity.position.floored();
  const offsets: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (const [dx, dz] of offsets) {
    const groundPos = feet.offset(dx, -1, dz);
    const targetPos = groundPos.offset(0, 1, 0);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);
    if (!ground || ground.boundingBox !== 'block') continue;
    if (!target || target.boundingBox !== 'empty') continue;

    try {
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
