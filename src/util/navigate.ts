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

export interface SearchOutwardOptions {
  /** Direction legs to walk, as (dx, dz) unit multipliers. Default: 4 cardinal directions. */
  legs?: Array<[number, number]>;
  /** How far to walk per leg, in blocks. */
  legDistance?: number;
  /** Max time to spend walking a single leg, in ms. */
  legTimeoutMs?: number;
}

const DEFAULT_LEGS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Mineflayer only perceives what the server has streamed in around the bot's current
 * position — "search wider" for anything fundamentally means walking somewhere new so the
 * server sends fresh chunks/entities. Walks a few legs outward, rechecking `isPresent()`
 * after each, instead of giving up immediately. Bounded so a genuinely absent target fails
 * promptly rather than wandering forever.
 */
export async function searchOutward(
  bot: Bot,
  isPresent: () => boolean,
  reflex?: ReflexLayer,
  shouldStop?: () => boolean,
  opts: SearchOutwardOptions = {},
): Promise<boolean> {
  const legs = opts.legs ?? DEFAULT_LEGS;
  const legDistance = opts.legDistance ?? 28;
  const legTimeoutMs = opts.legTimeoutMs ?? 12000;

  for (const [dx, dz] of legs) {
    if (shouldStop?.()) return false;
    if (isPresent()) return true;
    const base = bot.entity.position;
    const target = { x: base.x + dx * legDistance, y: base.y, z: base.z + dz * legDistance };
    await walkToward(bot, () => target, 3, reflex, shouldStop, legTimeoutMs);
  }
  return isPresent();
}
