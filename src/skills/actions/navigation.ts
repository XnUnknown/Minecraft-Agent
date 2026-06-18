import pathfinderPkg from 'mineflayer-pathfinder';
import type { Skill } from '../types';
import { walkToward } from '../../util/navigate';

const { goals } = pathfinderPkg;

export const goToPlayer: Skill = {
  def: {
    name: 'goToPlayer',
    description: 'Walk to a named player. Use when asked to come to, go to, or approach someone.',
    parameters: {
      type: 'object',
      properties: {
        playerName: { type: 'string', description: 'Exact username of the player to walk to.' },
        range: { type: 'integer', description: 'How close to get, in blocks (default 2).' },
      },
      required: ['playerName'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const playerName = String(args.playerName ?? '');
    const range = Number.isFinite(Number(args.range)) ? Number(args.range) : 2;
    if (!bot.players[playerName]?.entity) return `Cannot see player "${playerName}" — they may be out of range.`;
    // Wait until we actually reach them (and resume if the reflex pre-empts us en route).
    const arrived = await walkToward(
      bot,
      () => bot.players[playerName]?.entity?.position ?? null,
      range,
      ctx.reflex,
      ctx.shouldStop,
    );
    return arrived ? `Reached ${playerName}.` : `Couldn't get to ${playerName} (lost sight or path blocked).`;
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
  async run(bot, args, ctx) {
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    const range = Number.isFinite(Number(args.range)) ? Number(args.range) : 1;
    if (![x, y, z].every((n) => Number.isFinite(n))) return 'Invalid coordinates.';
    const arrived = await walkToward(bot, () => ({ x, y, z }), range, ctx.reflex, ctx.shouldStop);
    return arrived ? `Arrived at (${x}, ${y}, ${z}).` : `Couldn't reach (${x}, ${y}, ${z}) (path blocked).`;
  },
};

export const followPlayer: Skill = {
  def: {
    name: 'followPlayer',
    description:
      'Continuously follow a player, keeping pace as they move, until told to stop. Use for "follow me", "come with me", "stay with me" (NOT a one-off "come here").',
    parameters: {
      type: 'object',
      properties: {
        playerName: { type: 'string', description: 'Exact username of the player to follow.' },
        range: { type: 'integer', description: 'How closely to follow, in blocks (default 2).' },
      },
      required: ['playerName'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const playerName = String(args.playerName ?? '');
    const range = Number.isFinite(Number(args.range)) ? Number(args.range) : 2;
    const setFollow = (): boolean => {
      const target = bot.players[playerName]?.entity;
      if (!target) return false;
      // Dynamic goal: pathfinder re-routes as the player moves, so it keeps following.
      bot.pathfinder.setGoal(new goals.GoalFollow(target, range), true);
      return true;
    };
    if (!setFollow()) return `Cannot see player "${playerName}" — they may be out of range.`;
    // If the reflex pre-empts us (flee/defend), re-establish the follow once it releases.
    ctx.reflex?.setOnReleaseNav(() => {
      setFollow();
    });
    return `Now following ${playerName} until you tell me to stop.`;
  },
};

export const stopMoving: Skill = {
  def: {
    name: 'stopMoving',
    description: 'Stop all current movement and pathfinding.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(bot, _args, ctx) {
    ctx.reflex?.setOnReleaseNav(undefined);
    bot.pathfinder.setGoal(null);
    return 'Stopped moving.';
  },
};
