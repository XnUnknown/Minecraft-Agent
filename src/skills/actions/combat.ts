import type { Skill } from '../types';
import { clampInt } from '../util';
import { nearestHostile, attackUntilDead } from '../../util/combat';
import { equipBestWeapon } from '../../util/equip';

export const attackNearestMob: Skill = {
  def: {
    name: 'attackNearestMob',
    description:
      'Find and kill nearby creatures. Without mobType, only fights ever-hostile monsters ' +
      '(zombie, skeleton, spider, creeper, etc.) — use for "kill monsters" or "clear the area". ' +
      'With an explicit mobType (any creature name, e.g. cow, pig, polar_bear, wolf), targets ' +
      'that creature specifically even if it is not normally hostile.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'How many monsters to kill (default 1).' },
        mobType: { type: 'string', description: 'Optional specific monster to target, e.g. zombie.' },
      },
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const count = clampInt(args.count, 1, 32, 1);
    const mobType = args.mobType ? String(args.mobType).toLowerCase() : undefined;

    // We drive combat ourselves; tell the reflex layer not to also grab targets.
    ctx.reflex?.setSuppressDefense(true);
    // Equip the best weapon we own before the first swing.
    await equipBestWeapon(bot);
    let killed = 0;
    try {
      for (let i = 0; i < count; i++) {
        if (ctx.shouldStop?.()) break;
        const target = nearestHostile(bot, 24, mobType);
        if (!target) break;
        await attackUntilDead(bot, target, 20000, ctx.shouldStop);
        killed += 1;
      }
    } finally {
      ctx.reflex?.setSuppressDefense(false);
    }

    if (killed > 0) return `Defeated ${killed} monster(s).`;
    return mobType ? `No ${mobType} nearby to fight.` : 'No monsters nearby to fight.';
  },
};
