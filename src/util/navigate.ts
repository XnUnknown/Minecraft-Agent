import type { Bot } from 'mineflayer';
import type { ReflexLayer } from '../reflex/ReflexLayer';
import { Vec3 } from 'vec3';
import baritonePkg from '@miner-org/mineflayer-baritone';

const { goals } = baritonePkg;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Walk to a specific coordinate using Baritone's smart waypoints.
 * Yields if the reflex layer pre-empts (e.g. during combat), resuming when free.
 */
export async function walkToward(
  bot: Bot,
  getPos: () => Vec3Like | null,
  range: number,
  reflex?: ReflexLayer,
  shouldStop?: () => boolean,
): Promise<boolean> {
  let pos = getPos();
  if (!pos) return false;

  // Wait if reflex is busy
  while (reflex?.isBusy() && !(shouldStop?.())) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (shouldStop?.()) {
    bot.ashfinder.stop();
    return false;
  }

  // Update pos after reflex waiting
  pos = getPos();
  if (!pos) return false;

  try {
    const goal = new goals.GoalNear(new Vec3(pos.x, pos.y, pos.z), range);
    const result = await bot.ashfinder.gotoSmart(goal);
    return result.status === 'success';
  } catch (err) {
    return false;
  }
}
