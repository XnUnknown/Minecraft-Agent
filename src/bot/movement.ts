import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { logger } from '../util/logger';

const { Movements } = pathfinderPkg;

/**
 * Build and apply a tuned Movements profile. The defaults are conservative and often
 * refuse to jump up a single block or sprint, which makes the bot look stuck on simple
 * terrain. We enable sprinting, parkour, 1x1 pillaring and door use so it can actually
 * climb a one-block step instead of grinding against it.
 */
export function configureMovements(bot: Bot): void {
  const m = new Movements(bot) as unknown as Record<string, unknown> & { setMovements?: never };
  m.allowSprinting = true;
  m.allowParkour = true;
  m.allow1by1towers = true;
  m.canOpenDoors = true;
  m.canDig = true;
  // Don't bail out of a path just because it requires a short scaffold-free jump.
  m.maxDropDown = 4;
  bot.pathfinder.setMovements(m as never);
  logger.info('Movements tuned: sprint + parkour + 1x1 towers + door use enabled.');
}

/**
 * Watchdog for the classic "won't hop a one-block step / wedged between blocks" case.
 *
 * It does NOT drive `forward` — pathfinder owns the per-tick controls, and injecting
 * forward fights it and can launch the bot into a wall (it ends up stuck mid-air). Instead
 * it waits until the bot has genuinely made no progress for a while (so a legitimate jump,
 * which completes in well under a second, is never interrupted), then escalates gently:
 *   1) a short JUMP-only pulse to pop it over a lip pathfinder under-jumped;
 *   2) if still stuck, force a fresh A* by re-issuing the current goal (preserving whether
 *      it was a dynamic/follow goal), which usually finds the working route.
 */
export class StuckMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private lastPos?: { x: number; y: number; z: number };
  private stalls = 0;

  constructor(
    private readonly bot: Bot,
    private readonly checkMs = 700,
    private readonly minProgress = 0.5,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* ignore */
      }
    }, this.checkMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const bot = this.bot;
    if (!bot.entity) return;

    const pf = bot.pathfinder;
    const moving = pf.isMoving?.() ?? false;
    // Not pathing, or deliberately paused to mine a block in the way -> not stuck.
    if (!moving || pf.isMining?.() || pf.isBuilding?.()) {
      this.stalls = 0;
      this.lastPos = undefined;
      return;
    }

    const p = bot.entity.position;
    if (this.lastPos) {
      const moved = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z) + Math.abs(p.y - this.lastPos.y);
      if (moved < this.minProgress) {
        this.stalls += 1;
        // ~1.4s of no progress: try a hop. ~2.8s: force a re-path and reset.
        if (this.stalls === 2) this.jumpPulse();
        else if (this.stalls >= 4) {
          this.repath();
          this.stalls = 0;
        }
      } else {
        this.stalls = 0;
      }
    }
    this.lastPos = { x: p.x, y: p.y, z: p.z };
  }

  /** A brief jump (no forward) to clear a one-block lip pathfinder failed to hop. */
  private jumpPulse(): void {
    const bot = this.bot;
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 350);
  }

  /** Re-issue the current goal to force pathfinder to recompute a fresh route. */
  private repath(): void {
    const pf = this.bot.pathfinder as unknown as {
      goal?: { entity?: unknown } | null;
      setGoal(goal: unknown, dynamic?: boolean): void;
    };
    const goal = pf.goal;
    if (!goal) return;
    try {
      pf.setGoal(goal, Boolean(goal.entity)); // entity-bearing goals (GoalFollow) are dynamic
    } catch {
      /* ignore */
    }
  }
}
