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

/** Past this initial distance a walk counts as "long travel": the bot lowers the reflex layer
 *  so mobs can't pull it off course, and the deadline scales with distance instead of the flat
 *  timeout (a 1000-block trek legitimately takes minutes — it must not be mistaken for "stuck"). */
const LONG_TRAVEL_BLOCKS = 48;
/** Give up only if we make no forward progress for this long. This — not a wall-clock cap — is
 *  the real "stuck" signal, so an arbitrarily long journey succeeds as long as it keeps closing. */
const NO_PROGRESS_MS = 20000;
/** Absolute backstop so a pathological case can't loop forever, even while "progressing". */
const MAX_TRAVEL_MS = 600000;

/**
 * Walk to within `range` of a (possibly moving) position and **wait until we actually
 * arrive** — unlike a bare setGoal, which returns immediately. Crucially, it survives reflex
 * pre-emption: while the reflex layer is fleeing or fighting we yield the path to it, then
 * re-issue our own goal once it lets go, so the assigned task resumes instead of being
 * forgotten after a scrap with a zombie. Returns true if we arrived, false on stall/loss.
 *
 * For a far destination it fails only on a genuine *stall* (no progress for NO_PROGRESS_MS),
 * not a fixed clock — so a 500-1000 block journey isn't wrongly reported as "couldn't reach"
 * just because it's long — and it puts the reflex in travel mode so a stray mob can't divert it,
 * restoring full survival the moment it arrives or gives up.
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
  const me0 = bot.entity?.position;
  const p0 = getPos();
  const startDist = me0 && p0 ? dist(me0, p0) : 0;
  const longTravel = !!reflex && startDist > LONG_TRAVEL_BLOCKS;
  // Short hops keep the caller's flat deadline; long hauls get a distance-scaled one.
  const deadlineMs = longTravel ? Math.min(MAX_TRAVEL_MS, Math.max(timeoutMs, startDist * 1000)) : timeoutMs;

  if (longTravel) reflex!.setTravelMode(true);
  let lastIssued: Vec3Like | null = null;
  let bestDist = Infinity;
  let lastProgressAt = Date.now();

  try {
    while (Date.now() - start < deadlineMs) {
      if (shouldStop?.()) {
        bot.pathfinder.setGoal(null);
        return false;
      }
      const pos = getPos();
      if (!pos) return false;

      const me = bot.entity?.position;
      if (me) {
        const d = dist(me, pos);
        if (d <= range + 0.5) {
          bot.pathfinder.setGoal(null);
          return true;
        }
        // Track best-ever distance; meaningful progress resets the stall clock.
        if (d < bestDist - 1) {
          bestDist = d;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > NO_PROGRESS_MS) {
          bot.pathfinder.setGoal(null);
          return false;
        }
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
  } finally {
    if (longTravel) reflex!.setTravelMode(false);
  }
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
