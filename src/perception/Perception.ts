import type { Bot } from 'mineflayer';
import type { Blackboard } from '../blackboard/Blackboard';
import type { PerceivedEntity, WorldState, NearbyBlock } from './types';
import { classifyEntity } from './classify';
import { summarizeWorldState } from './summarize';
import { compassDirection } from '../util/geometry';
import { logger } from '../util/logger';

/** Common terrain/filler blocks — collapsed into a plain name list instead of itemized. */
const TERRAIN_FILLER = new Set([
  'air', 'cave_air', 'void_air', 'stone', 'deepslate', 'dirt', 'grass_block', 'podzol',
  'sand', 'red_sand', 'sandstone', 'gravel', 'clay', 'water', 'lava', 'bedrock',
  'andesite', 'granite', 'diorite', 'tuff', 'calcite', 'snow', 'snow_block', 'ice',
  'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'seagrass', 'kelp', 'mud',
]);

/**
 * Scans a radius around the bot for every distinct non-terrain block type (ores, logs,
 * leaves, crops, structures, ...) so the LLM gets ground truth of exact names actually
 * present — e.g. "dark_oak_log" — instead of guessing a generic example from a tool's
 * description. Only called once per LLM planning turn (not on the fast perception tick),
 * since a 16-block survey is too heavy to run at 300ms cadence.
 */
export function surveyNearbyBlocks(bot: Bot, radius = 16): { interesting: NearbyBlock[]; terrain: string[] } {
  const me = bot.entity?.position;
  if (!me) return { interesting: [], terrain: [] };

  const positions = bot.findBlocks({
    point: me,
    maxDistance: radius,
    count: 1500,
    matching: (block: unknown) => {
      const b = block as { name?: string } | null;
      return !!b?.name && b.name !== 'air';
    },
  });

  const tally = new Map<string, { count: number; nearest: number; pos: { x: number; y: number; z: number } }>();
  const terrain = new Set<string>();

  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (!block) continue;
    if (TERRAIN_FILLER.has(block.name)) {
      terrain.add(block.name);
      continue;
    }
    const d = Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z);
    const entry = tally.get(block.name);
    if (entry) {
      entry.count += 1;
      if (d < entry.nearest) {
        entry.nearest = d;
        entry.pos = pos;
      }
    } else {
      tally.set(block.name, { count: 1, nearest: d, pos });
    }
  }

  const interesting = [...tally.entries()]
    .map(([name, v]) => ({ name, count: v.count, distance: v.nearest, direction: compassDirection(me, v.pos) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 25);

  return { interesting, terrain: [...terrain] };
}

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
    if (!ws) return 'No world state available yet.';
    const blocks = surveyNearbyBlocks(this.bot, 16);
    return summarizeWorldState(ws, blocks);
  }
}
