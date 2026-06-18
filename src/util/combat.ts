import type { Bot } from 'mineflayer';
import { classifyEntity } from '../perception/classify';

/** Minimal shape we need from a Mineflayer entity (avoids a hard prismarine-entity dep here). */
export interface CombatEntity {
  id: number;
  name?: string | null;
  type?: string;
  isValid?: boolean;
  position?: { distanceTo(o: unknown): number };
}

/** Nearest hostile entity within `range`, optionally filtered by (substring) name. */
export function nearestHostile(bot: Bot, range: number, nameFilter?: string): CombatEntity | null {
  const me = bot.entity?.position;
  if (!me) return null;

  let best: CombatEntity | null = null;
  let bestDist = Infinity;
  for (const e of Object.values(bot.entities) as unknown as CombatEntity[]) {
    if (!e || !e.position || e.isValid === false) continue;
    if (classifyEntity(e) !== 'hostile') continue;
    if (nameFilter && !(e.name ?? '').toLowerCase().includes(nameFilter)) continue;
    const d = e.position.distanceTo(me);
    if (d <= range && d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/** Attack a target with the pvp plugin until it dies, a timeout elapses, or we're cancelled. */
export function attackUntilDead(
  bot: Bot,
  entity: CombatEntity,
  timeoutMs = 20000,
  shouldStop?: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const pvp = (bot as unknown as { pvp: { attack(e: unknown): void; stop(): void } }).pvp;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearInterval(iv);
      clearTimeout(to);
      try {
        pvp.stop();
      } catch {
        /* ignore */
      }
      resolve();
    };
    try {
      pvp.attack(entity);
    } catch {
      finish();
      return;
    }
    const iv = setInterval(() => {
      if (entity.isValid === false || !bot.entities[entity.id] || shouldStop?.()) finish();
    }, 300);
    const to = setTimeout(finish, timeoutMs);
  });
}
