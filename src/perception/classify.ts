import type { EntityKind } from './types';

/** Always-hostile mobs (attack on sight). */
const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'phantom',
  'vex', 'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'silverfish', 'endermite',
  'guardian', 'elder_guardian', 'shulker', 'warden', 'breeze', 'hoglin', 'zoglin', 'piglin_brute',
  'wither', 'ender_dragon',
]);

/** Neutral mobs (hostile only when provoked or conditionally). */
const NEUTRAL = new Set([
  'enderman', 'piglin', 'zombified_piglin', 'wolf', 'spider_neutral', 'bee', 'llama', 'trader_llama',
  'panda', 'polar_bear', 'goat', 'dolphin', 'iron_golem', 'fox',
]);

/** Classifies a Mineflayer/Prismarine entity into a coarse threat category. */
export function classifyEntity(entity: { type?: string; name?: string | null }): EntityKind {
  const type = entity.type ?? '';
  if (type === 'player') return 'player';
  if (type === 'object' || type === 'orb' || type === 'projectile' || type === 'global') return 'object';

  const name = (entity.name ?? '').toLowerCase();
  if (HOSTILE.has(name)) return 'hostile';
  if (NEUTRAL.has(name)) return 'neutral';
  if (name) return 'passive';
  return 'other';
}
