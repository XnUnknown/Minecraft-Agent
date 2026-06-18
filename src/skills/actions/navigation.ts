import pathfinderPkg from 'mineflayer-pathfinder';
import type { Skill } from '../types';

const { goals } = pathfinderPkg;

export const goToPlayer: Skill = {
  def: {
    name: 'goToPlayer',
    description: 'Walk to a named player. Use when asked to come to, go to, or approach someone.',
    parameters: {
      type: 'object',
      properties: {
        playerName: { type: 'string', description: 'Exact username of the player to walk to.' },
        range: { type: 'integer', description: 'How close to get, in blocks (default 1).' },
      },
      required: ['playerName'],
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const playerName = String(args.playerName ?? '');
    const range = Number.isFinite(Number(args.range)) ? Number(args.range) : 1;
    const target = bot.players[playerName]?.entity;
    if (!target) return `Cannot see player "${playerName}" — they may be out of range.`;
    const { x, y, z } = target.position;
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
    return `Heading to ${playerName} at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}).`;
  },
};

export const goToCoordinates: Skill = {
  def: {
    name: 'goToCoordinates',
    description: 'Walk to specific x y z block coordinates.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        z: { type: 'number', description: 'Z coordinate' },
        range: { type: 'integer', description: 'How close to get, in blocks (default 1).' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    const range = Number.isFinite(Number(args.range)) ? Number(args.range) : 1;
    if (![x, y, z].every((n) => Number.isFinite(n))) return 'Invalid coordinates.';
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
    return `Heading to (${x}, ${y}, ${z}).`;
  },
};

export const stopMoving: Skill = {
  def: {
    name: 'stopMoving',
    description: 'Stop all current movement and pathfinding.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(bot) {
    bot.pathfinder.setGoal(null);
    return 'Stopped moving.';
  },
};
