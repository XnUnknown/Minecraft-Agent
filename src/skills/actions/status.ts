import type { Skill } from '../types';

export const reportStatus: Skill = {
  def: {
    name: 'reportStatus',
    description: 'Report current position, health, hunger, and a short inventory summary in chat.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(bot) {
    const p = bot.entity.position;
    const items = bot.inventory.items();
    const inv = items.length
      ? items.map((i) => `${i.count}x ${i.name}`).slice(0, 10).join(', ')
      : 'empty';
    const report = `Pos (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}); HP ${bot.health}/20; food ${bot.food}/20; inv: ${inv}.`;
    bot.chat(report);
    return { ok: true, message: report };
  },
};
