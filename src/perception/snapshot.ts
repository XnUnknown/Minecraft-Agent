import type { Bot } from 'mineflayer';

/**
 * Minimal text observation for the LLM (Stage 3). The full tiered/summarized
 * perception system (Blackboard) arrives in Stage 4.
 */
export function buildObservation(bot: Bot): string {
  const p = bot.entity.position;
  const others = Object.keys(bot.players).filter((n) => n !== bot.username);

  const mobs = Object.values(bot.entities)
    .filter((e) => e.type === 'mob' && e.position && e.position.distanceTo(bot.entity.position) < 24)
    .map((e) => `${e.name ?? 'mob'}(${e.position.distanceTo(bot.entity.position).toFixed(0)}m)`)
    .slice(0, 6);

  const items = bot.inventory.items();
  const inv = items.length ? items.map((i) => `${i.count}x ${i.name}`).slice(0, 8).join(', ') : 'empty';

  return [
    `Position: (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`,
    `Health: ${bot.health}/20, Hunger: ${bot.food}/20`,
    `Time(ticks): ${bot.time.timeOfDay}, Dimension: ${bot.game.dimension}`,
    `Players nearby: ${others.length ? others.join(', ') : 'none'}`,
    `Mobs nearby: ${mobs.length ? mobs.join(', ') : 'none'}`,
    `Inventory: ${inv}`,
  ].join('\n');
}
