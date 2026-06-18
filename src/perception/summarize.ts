import type { PerceivedEntity, WorldState } from './types';
import { round } from '../util/geometry';

/**
 * Compresses a WorldState into a compact, tiered text observation for the LLM:
 * immediate (<=8m) is detailed; local (8-32m) is grouped with threats called out;
 * distant (>32m) is counted by direction. Keeps prompts small regardless of how much
 * the bot can see.
 */
export function summarizeWorldState(ws: WorldState): string {
  const s = ws.self;
  const env = ws.environment;
  const lines: string[] = [];

  lines.push(
    `Self: pos (${round(s.position.x)}, ${round(s.position.y)}, ${round(s.position.z)}), ` +
      `HP ${s.health}/20, food ${s.food}/20, holding ${s.heldItem ?? 'nothing'}` +
      `${s.inWater ? ', in water' : ''}`,
  );
  lines.push(
    `Env: ${env.biome}, ${env.isDay ? 'day' : 'night'}${env.raining ? ', raining' : ''}, dimension ${s.dimension}`,
  );
  lines.push(`Players nearby: ${ws.players.length ? ws.players.join(', ') : 'none'}`);

  const mobs = ws.entities.filter((e) => e.kind !== 'player' && e.kind !== 'object');
  const immediate = mobs.filter((e) => e.distance <= 8);
  const local = mobs.filter((e) => e.distance > 8 && e.distance <= 32);
  const distant = mobs.filter((e) => e.distance > 32);

  if (immediate.length) {
    lines.push(
      `Immediate (<=8m): ` +
        immediate.map((e) => `${e.name}[${e.kind}] ${round(e.distance)}m ${e.direction}`).join('; '),
    );
  }
  if (local.length) {
    lines.push(`Local (8-32m): ${groupByName(local)}`);
    const threats = local.filter((e) => e.kind === 'hostile' || e.kind === 'neutral');
    if (threats.length) {
      const shown = threats.slice(0, 6).map((e) => `${e.name} ${round(e.distance)}m ${e.direction}`).join('; ');
      const extra = threats.length > 6 ? ` (+${threats.length - 6} more)` : '';
      lines.push(`  threats: ${shown}${extra}`);
    }
  }
  if (distant.length) {
    lines.push(`Distant (>32m): ${groupByDirection(distant)}`);
  }
  if (!mobs.length) {
    lines.push('Mobs nearby: none');
  }

  lines.push(
    `Inventory: ${
      ws.inventory.length ? ws.inventory.map((i) => `${i.count}x ${i.name}`).slice(0, 12).join(', ') : 'empty'
    }`,
  );

  return lines.join('\n');
}

function groupByName(entities: PerceivedEntity[]): string {
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${n}x ${name}`).join(', ');
}

function groupByDirection(entities: PerceivedEntity[]): string {
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.direction, (counts.get(e.direction) ?? 0) + 1);
  return [...counts.entries()].map(([dir, n]) => `${n} to ${dir}`).join(', ');
}
