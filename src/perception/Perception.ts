import type { Bot } from 'mineflayer';
import type { Blackboard } from '../blackboard/Blackboard';
import type { PerceivedEntity, WorldState } from './types';
import { classifyEntity } from './classify';
import { summarizeWorldState } from './summarize';
import { compassDirection } from '../util/geometry';
import { logger } from '../util/logger';

export interface PerceptionOptions {
  /** How often to refresh the blackboard snapshot, in ms. */
  intervalMs?: number;
  /** Max entities to keep (nearest first). */
  maxEntities?: number;
  /** Ignore entities beyond this range, in blocks. */
  maxRange?: number;
}

/**
 * Builds structured WorldState snapshots from the bot and writes them to the Blackboard
 * on a fixed cadence (so the future Reflex Layer can read fresh state), and on demand for
 * the LLM via observe().
 */
export class Perception {
  private timer?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;
  private readonly maxEntities: number;
  private readonly maxRange: number;

  constructor(
    private readonly bot: Bot,
    private readonly blackboard: Blackboard,
    opts: PerceptionOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 300;
    this.maxEntities = opts.maxEntities ?? 24;
    this.maxRange = opts.maxRange ?? 64;
  }

  start(): void {
    if (this.timer) return;
    this.update();
    this.timer = setInterval(() => {
      try {
        this.update();
      } catch (err) {
        logger.warn(`perception update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.intervalMs);
    logger.info(`Perception started (refresh ${this.intervalMs}ms, range ${this.maxRange}).`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Build a fresh snapshot, store it on the blackboard, and return it. */
  update(): WorldState | null {
    const bot = this.bot;
    if (!bot.entity) return this.blackboard.get();
    const me = bot.entity.position;

    const entities: PerceivedEntity[] = [];
    const players: string[] = [];

    for (const e of Object.values(bot.entities)) {
      const ent = e as unknown as {
        id: number;
        type?: string;
        name?: string | null;
        username?: string;
        displayName?: string;
        position?: { x: number; y: number; z: number; distanceTo(o: unknown): number };
        health?: number;
      };
      if (!ent || ent === (bot.entity as unknown) || !ent.position) continue;
      if (ent.type === 'player' && ent.username === bot.username) continue;

      const distance = ent.position.distanceTo(me);
      if (distance > this.maxRange) continue;

      const kind = classifyEntity(ent);
      const label = (ent.name ?? ent.username ?? ent.displayName ?? 'unknown').toString();
      if (kind === 'player') players.push(ent.username ?? label);

      entities.push({
        id: ent.id,
        name: label.toLowerCase(),
        kind,
        position: { x: ent.position.x, y: ent.position.y, z: ent.position.z },
        distance,
        direction: compassDirection(me, ent.position),
        health: ent.health,
      });
    }

    entities.sort((a, b) => a.distance - b.distance);

    const feetBlock = bot.blockAt(me);
    const ws: WorldState = {
      updatedAt: Date.now(),
      self: {
        position: { x: me.x, y: me.y, z: me.z },
        health: Math.round(bot.health ?? 0),
        food: Math.round(bot.food ?? 0),
        dimension: bot.game?.dimension ?? 'overworld',
        onGround: bot.entity.onGround ?? false,
        inWater: /water/i.test(feetBlock?.name ?? ''),
        heldItem: bot.heldItem?.name ?? null,
      },
      inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
      players,
      entities: entities.slice(0, this.maxEntities),
      environment: {
        biome: (feetBlock as unknown as { biome?: { name?: string } } | null)?.biome?.name || 'unknown',
        timeOfDay: bot.time?.timeOfDay ?? 0,
        isDay: bot.time?.isDay ?? true,
        raining: Boolean((bot as unknown as { isRaining?: boolean }).isRaining),
      },
    };

    this.blackboard.set(ws);
    return ws;
  }

  /** Refresh state and return a compact text observation for the LLM. */
  observe(): string {
    const ws = this.update() ?? this.blackboard.get();
    return ws ? summarizeWorldState(ws) : 'No world state available yet.';
  }
}
