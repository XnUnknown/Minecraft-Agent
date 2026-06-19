import type { Bot } from 'mineflayer';
import type { Skill } from '../types';
import { clampInt } from '../util';
import { walkToward } from '../../util/navigate';

/** Minimal shape needed to locate a trader, mirroring util/combat.ts's CombatEntity. */
interface TraderEntity {
  id: number;
  name?: string | null;
  position?: { x: number; y: number; z: number; distanceTo(o: unknown): number };
}

function nearestTrader(bot: Bot, range: number): TraderEntity | null {
  const me = bot.entity?.position;
  if (!me) return null;
  let best: TraderEntity | null = null;
  let bestDist = Infinity;
  for (const e of Object.values(bot.entities) as unknown as TraderEntity[]) {
    if (!e?.position) continue;
    const name = (e.name ?? '').toLowerCase();
    if (name !== 'villager' && name !== 'wandering_trader') continue;
    const d = e.position.distanceTo(me);
    if (d <= range && d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

export const tradeWithVillager: Skill = {
  def: {
    name: 'tradeWithVillager',
    description:
      'Walk to the nearest villager or wandering trader and make a trade. If "item" is given, picks ' +
      'the trade whose result matches that item; otherwise uses the first available trade.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Desired result item of the trade, e.g. emerald, bread.' },
        count: { type: 'integer', description: 'How many times to repeat the trade (default 1).' },
      },
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const wanted = args.item ? String(args.item).toLowerCase() : undefined;
    const times = clampInt(args.count, 1, 64, 1);

    const target = nearestTrader(bot, 48);
    if (!target) return 'No villager or wandering trader nearby.';

    const arrived = await walkToward(
      bot,
      () => bot.entities[target.id]?.position ?? null,
      3,
      ctx.reflex,
      ctx.shouldStop,
    );
    if (!arrived) return "Couldn't reach the trader.";

    const entity = bot.entities[target.id];
    if (!entity) return 'Lost track of the trader.';

    let villager;
    try {
      villager = await bot.openVillager(entity);
    } catch (err) {
      return `Couldn't open trade: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const tradeIndex = villager.trades.findIndex(
        (t) => !t.tradeDisabled && (!wanted || t.outputItem.name.toLowerCase().includes(wanted)),
      );
      if (tradeIndex === -1) {
        return wanted ? `This trader doesn't offer ${wanted}.` : 'This trader has no available trades.';
      }
      const outputName = villager.trades[tradeIndex].outputItem.name;
      await bot.trade(villager, tradeIndex, times);
      return `Traded for ${times}x ${outputName}.`;
    } catch (err) {
      return `Trade failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      villager.close();
    }
  },
};
