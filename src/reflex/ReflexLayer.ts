import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { logger } from '../util/logger';
import { nearestHostile, type CombatEntity } from '../util/combat';
import { equipBestWeapon } from '../util/equip';

const { goals } = pathfinderPkg;

const FOOD_FALLBACK = new Set([
  'bread', 'apple', 'golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop',
  'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'cooked_rabbit', 'baked_potato',
  'carrot', 'golden_carrot', 'melon_slice', 'sweet_berries', 'glow_berries', 'beef', 'porkchop',
  'chicken', 'mutton', 'potato', 'cookie', 'pumpkin_pie', 'dried_kelp', 'rabbit', 'beetroot',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'suspicious_stew', 'honey_bottle',
]);

export interface ReflexOptions {
  tickMs?: number;
  /** Eat to keep hunger above this (also enables health regen). */
  eatFoodAt?: number;
  /** Below this health, retreat from threats instead of fighting. */
  fleeHealthAt?: number;
  /** Engage hostiles within this many blocks (self-defense). */
  engageRange?: number;
  /** Start fleeing creepers within this many blocks. */
  creeperRange?: number;
  /** Keep fleeing until all creepers are at least this far (hysteresis). */
  creeperSafeRange?: number;
}

/**
 * The custom "NPC brain": a fast survival loop (no LLM) that reads the live bot state and
 * enforces priorities — P0 eat / flee creepers / retreat when critical, P1 self-defense —
 * pre-empting whatever the agent is doing. Skills that drive combat themselves call
 * setSuppressDefense(true) so the reflex doesn't fight the same target twice.
 */
export class ReflexLayer {
  private timer?: ReturnType<typeof setInterval>;
  private suppressDefense = false;
  private travelMode = false;
  private eating = false;
  private engaging = false;
  private fleeing = false;
  private currentTargetId?: number;
  private onReleaseNav?: () => void;

  private readonly tickMs: number;
  private readonly eatFoodAt: number;
  private readonly fleeHealthAt: number;
  private readonly engageRange: number;
  private readonly creeperRange: number;
  private readonly creeperSafeRange: number;

  constructor(
    private readonly bot: Bot,
    opts: ReflexOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? 150;
    this.eatFoodAt = opts.eatFoodAt ?? 16;
    this.fleeHealthAt = opts.fleeHealthAt ?? 6;
    this.engageRange = opts.engageRange ?? 5;
    this.creeperRange = opts.creeperRange ?? 8;
    this.creeperSafeRange = opts.creeperSafeRange ?? 16;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        logger.warn(`reflex tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.tickMs);
    logger.info(`Reflex layer started (${this.tickMs}ms): auto-eat, flee creepers, self-defense.`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Skills doing their own combat call this so the reflex doesn't double-drive pvp. */
  setSuppressDefense(v: boolean): void {
    this.suppressDefense = v;
    if (v) this.stopEngage();
  }

  /**
   * Travel mode: while running to a far-off destination we deliberately "lower" the reflex so
   * mobs can't yank the bot off its path — it ignores creeper-flee and self-defense and just
   * keeps walking (auto-eat still runs; it's stationary and feeds regen). Long-distance walks
   * turn this on at the start and OFF again on arrival, so normal survival resumes automatically.
   * Entering travel drops any fight/flee in progress WITHOUT clearing the goal — the traveller
   * owns the path.
   */
  setTravelMode(on: boolean): void {
    if (this.travelMode === on) return;
    this.travelMode = on;
    if (on) {
      if (this.engaging) {
        this.engaging = false;
        this.currentTargetId = undefined;
        try {
          (this.bot as unknown as { pvp: { stop(): void } }).pvp.stop();
        } catch {
          /* ignore */
        }
      }
      if (this.fleeing) {
        this.fleeing = false;
        this.bot.setControlState('sprint', false);
      }
    }
    logger.info(`Reflex: travel mode ${on ? 'ON — ignoring mobs to stay on course' : 'OFF — full survival resumed'}.`);
  }

  /**
   * Register what to do when the reflex finishes a flee/defend and releases control of
   * navigation — e.g. resume the active task's path instead of going limp. If unset, the
   * reflex just clears the goal.
   */
  setOnReleaseNav(cb: (() => void) | undefined): void {
    this.onReleaseNav = cb;
  }

  /** True while the reflex is actively fleeing or fighting (a task may want to pause). */
  isBusy(): boolean {
    return this.fleeing || this.engaging;
  }

  private tick(): void {
    const bot = this.bot;
    if (!bot.entity) return;

    // P0a: keep fed (drives health regen). Runs even while travelling — eating is stationary.
    if (!this.eating && (bot.food ?? 20) <= this.eatFoodAt && this.hasFood()) {
      void this.eat();
    }

    // Travelling far: skip every path-deviating reaction so a wandering mob can't pull the bot
    // off its route. setTravelMode(false) on arrival restores the checks below.
    if (this.travelMode) return;

    // P0b: flee nearby creepers — never melee them. Hysteresis: once fleeing, keep going
    // until every creeper is past the safe range so we don't stutter-step away.
    const creeperDetect = this.fleeing ? this.creeperSafeRange : this.creeperRange;
    const creeper = nearestHostile(bot, creeperDetect, 'creeper');
    if (creeper) {
      this.flee(creeper);
      return;
    }
    if (this.fleeing) this.stopFlee();

    // P1: self-defense (unless a skill is driving combat).
    if (!this.suppressDefense) {
      const threat = nearestHostile(bot, this.engageRange);
      if (threat) {
        if ((bot.health ?? 20) <= this.fleeHealthAt) this.flee(threat);
        else this.engage(threat);
        return;
      }
      this.stopEngage();
    }
  }

  private hasFood(): boolean {
    return this.bot.inventory.items().some((i) => this.isFood(i.name));
  }

  private isFood(name: string): boolean {
    const reg = (this.bot.registry as unknown as { foodsByName?: Record<string, unknown> }).foodsByName;
    return (reg ? name in reg : false) || FOOD_FALLBACK.has(name);
  }

  private async eat(): Promise<void> {
    const food = this.bot.inventory.items().find((i) => this.isFood(i.name));
    if (!food) return;
    this.eating = true;
    try {
      await this.bot.equip(food, 'hand');
      await (this.bot as unknown as { consume(): Promise<void> }).consume();
    } catch {
      /* interrupted — try again next tick */
    } finally {
      this.eating = false;
    }
  }

  private engage(target: CombatEntity): void {
    if (this.engaging && this.currentTargetId === target.id) return;
    this.engaging = true;
    this.currentTargetId = target.id;
    // Pick up the best weapon we own before swinging — fists are a last resort.
    void equipBestWeapon(this.bot);
    try {
      (this.bot as unknown as { pvp: { attack(e: unknown): void } }).pvp.attack(target);
    } catch {
      /* ignore */
    }
  }

  private stopEngage(): void {
    if (!this.engaging) return;
    this.engaging = false;
    this.currentTargetId = undefined;
    try {
      (this.bot as unknown as { pvp: { stop(): void } }).pvp.stop();
    } catch {
      /* ignore */
    }
    // Fight's over — hand navigation back so the assigned task picks up where it left off.
    this.releaseNav();
  }

  private flee(from: CombatEntity): void {
    this.stopEngage();
    const wasFleeing = this.fleeing;
    this.fleeing = true;
    this.bot.setControlState('sprint', true);
    try {
      // Invert a long follow so we sprint well clear of the threat, not 3-4 blocks.
      const away = new goals.GoalInvert(new goals.GoalFollow(from as never, 20));
      this.bot.pathfinder.setGoal(away, true);
    } catch {
      /* ignore */
    }
    if (!wasFleeing) logger.info('Reflex: fleeing a threat.');
  }

  private stopFlee(): void {
    if (!this.fleeing) return;
    this.fleeing = false;
    this.bot.setControlState('sprint', false);
    this.releaseNav();
  }

  /**
   * Hand navigation back to the active task if it registered a resume callback (e.g. keep
   * following a player); otherwise just clear the goal. The task's own skills also watch
   * isBusy() and re-path on their own, so this mainly avoids drifting toward a dead target.
   */
  private releaseNav(): void {
    if (this.onReleaseNav) {
      try {
        this.onReleaseNav();
        return;
      } catch {
        /* fall through to clearing the goal */
      }
    }
    try {
      this.bot.pathfinder.setGoal(null);
    } catch {
      /* ignore */
    }
  }
}
