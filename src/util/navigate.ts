import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { ReflexLayer } from '../reflex/ReflexLayer';

const { goals } = pathfinderPkg;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

function dist(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Walk to within `range` of a (possibly moving) position and **wait until we actually
 * arrive** — unlike a bare setGoal, which returns immediately. Crucially, it survives reflex
 * pre-emption: while the reflex layer is fleeing or fighting we yield the path to it, then
 * re-issue our own goal once it lets go, so the assigned task resumes instead of being
 * forgotten after a scrap with a zombie. Returns true if we arrived, false on timeout/loss.
 */
export async function walkToward(
  bot: Bot,
  getPos: () => Vec3Like | null,
  range: number,
  reflex?: ReflexLayer,
  shouldStop?: () => boolean,
  timeoutMs = 45000,
): Promise<boolean> {
  const start = Date.now();
  let lastIssued: Vec3Like | null = null;

  while (Date.now() - start < timeoutMs) {
    if (shouldStop?.()) {
      bot.pathfinder.setGoal(null);
      return false;
    }
    const pos = getPos();
    if (!pos) return false;

    const me = bot.entity?.position;
    if (me && dist(me, pos) <= range + 0.5) {
      bot.pathfinder.setGoal(null);
      return true;
    }

    if (reflex?.isBusy()) {
      // Survival has the wheel (fleeing/fighting). Wait, and force a fresh path afterwards.
      lastIssued = null;
      await sleep(300);
      continue;
    }

    // (Re)issue the goal if we've never issued it, the target drifted, or we've stalled out.
    const targetMoved = !lastIssued || dist(lastIssued, pos) > 1.5;
    if (targetMoved || !bot.pathfinder.isMoving()) {
      bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, range));
      lastIssued = { x: pos.x, y: pos.y, z: pos.z };
    }
    await sleep(300);
  }
  return false;
}
