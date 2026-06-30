import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import type { Skill, SkillContext } from '../types';
import { walkToward } from '../../util/navigate';
import { findItem, countItem, tryPlaceAt, alreadyIs } from '../../util/place';

/** Cap on blocks placed in ONE fillArea/buildLine call, so a huge region reports progress and
 *  yields control rather than hogging the loop for minutes. Skipped (already-correct) cells don't
 *  count — re-calling the same tool resumes where it left off. */
const MAX_PLACE_PER_CALL = 128;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number => Math.floor(Number(v));
const hasCoords = (args: Record<string, unknown>, keys: string[]): boolean =>
  keys.every((k) => args[k] !== undefined && args[k] !== null && args[k] !== '' && Number.isFinite(Number(args[k])));

/** Walk into placing reach of a cell and set the (already-equipped) block down, recording it into
 *  the active build session on success. Returns 'placed' | 'skip' (already correct) | 'fail'. */
async function placeOne(bot: Bot, target: Vec3, blockName: string, ctx: SkillContext): Promise<'placed' | 'skip' | 'fail'> {
  if (alreadyIs(bot, target, blockName)) return 'skip';
  if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 3.5) {
    await walkToward(bot, () => target, 2, ctx.reflex, ctx.shouldStop);
  }
  const ok = await tryPlaceAt(bot, target);
  if (ok && ctx.building?.enabled) ctx.building.session.record(target, blockName);
  return ok ? 'placed' : 'fail';
}

/** Shared driver for fillArea/buildLine: equip once, place a list of cells bottom-up & nearest-first
 *  (so blocks always have something to build against), bounded + resumable. */
async function buildCells(bot: Bot, cells: Vec3[], blockName: string, ctx: SkillContext): Promise<{ ok: boolean; message: string }> {
  const item = findItem(bot, blockName);
  if (!item) return { ok: false, message: `I have no ${blockName} to build with — gather or craft some first.` };
  try {
    await bot.equip(item, 'hand');
  } catch (err) {
    return { ok: false, message: `Couldn't hold ${item.name}: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Bottom-up first (support), then nearest to the bot to minimise walking.
  const me = bot.entity.position;
  cells.sort((a, b) => a.y - b.y || me.distanceTo(a) - me.distanceTo(b));

  let placed = 0, skipped = 0, failed = 0, ran = 0;
  for (const cell of cells) {
    if (ctx.shouldStop?.()) break;
    if (ctx.reflex?.isBusy()) { await sleep(300); }
    // Re-equip if the reflex's auto-eat swapped our hand out from under us.
    if (bot.heldItem?.name !== item.name) {
      const again = findItem(bot, blockName);
      if (!again) { failed += 1; break; }
      try { await bot.equip(again, 'hand'); } catch { /* try anyway */ }
    }
    const r = await placeOne(bot, cell, blockName, ctx);
    if (r === 'placed') { placed += 1; ran += 1; }
    else if (r === 'skip') skipped += 1;
    else failed += 1;
    if (ran >= MAX_PLACE_PER_CALL) {
      return {
        ok: true,
        message: `Placed ${placed} ${blockName} (${skipped} already there). Hit the ${MAX_PLACE_PER_CALL}-block batch cap — call again to continue.`,
      };
    }
  }
  const total = placed + skipped;
  if (placed === 0 && failed > 0 && skipped === 0) {
    return { ok: false, message: `Couldn't place any ${blockName} (${failed} spots blocked or out of reach).` };
  }
  return {
    ok: true,
    message: `Placed ${placed} ${blockName}${skipped ? `, ${skipped} already in place` : ''}${failed ? `, ${failed} failed` : ''}. ${total} of ${cells.length} cells done.`,
  };
}

export const enterBuildMode: Skill = {
  def: {
    name: 'enterBuildMode',
    description:
      'Switch into BUILDING MODE before constructing anything. This unlocks the building tools ' +
      '(fillArea, buildLine, inspectArea, buildStatus) and starts tracking a structural model of ' +
      'what you place. Give the structure a short name and a description of what you intend to ' +
      'build so you can reason about it as you go (you have no vision — this record is your memory).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the build, e.g. "stone_hut".' },
        description: { type: 'string', description: 'What you plan to build, e.g. "5x5 cobblestone hut with a door".' },
      },
      additionalProperties: false,
    },
  },
  async run(_bot, args, ctx) {
    if (!ctx.building) return { ok: false, message: 'Building mode is unavailable.' };
    ctx.building.enter(String(args.name ?? ''), String(args.description ?? ''));
    return {
      ok: true,
      message:
        `Building mode ON${args.name ? ` for "${args.name}"` : ''}. Building tools and your structural model are now available. ` +
        'Use inspectArea to read the ground truth, fillArea/buildLine to place, and buildStatus to review what you have made.',
    };
  },
};

export const exitBuildMode: Skill = {
  def: {
    name: 'exitBuildMode',
    description: 'Leave building mode when the structure is finished. Hides the building tools again.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(_bot, _args, ctx) {
    if (!ctx.building) return { ok: false, message: 'Building mode is unavailable.' };
    const summary = ctx.building.session.summary();
    ctx.building.exit();
    return { ok: true, message: `Building mode OFF. ${summary}` };
  },
};

export const buildStatus: Skill = {
  def: {
    name: 'buildStatus',
    description:
      'Report your current structural model: what you have built so far, where, the footprint and ' +
      'size, block counts, per-layer breakdown, and whether each recorded block is still present in ' +
      'the world. Use this to reason about a structure you cannot see.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(bot, _args, ctx) {
    if (!ctx.building) return { ok: false, message: 'Building mode is unavailable.' };
    return { ok: true, message: ctx.building.session.summary(bot) };
  },
};

export const inspectArea: Skill = {
  def: {
    name: 'inspectArea',
    description:
      'Scan the real blocks in a cube around a point and report them layer by layer — your eyes ' +
      'without a vision model. Returns an ASCII top-down map per height level (with a legend) for ' +
      'small radii, or a block tally for large ones. Use it before building (to see the ground/ ' +
      'obstacles) and after (to verify what actually landed). Omit x,y,z to scan around yourself.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'Center X (optional — defaults to the bot).' },
        y: { type: 'integer', description: 'Center Y (optional).' },
        z: { type: 'integer', description: 'Center Z (optional).' },
        radius: { type: 'integer', description: 'Cube half-size in blocks (default 4, max 6).' },
      },
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const center = hasCoords(args, ['x', 'y', 'z'])
      ? new Vec3(num(args.x), num(args.y), num(args.z))
      : bot.entity.position.floored();
    const r = Math.max(1, Math.min(6, Number.isFinite(Number(args.radius)) ? num(args.radius) : 4));
    return { ok: true, message: describeArea(bot, center, r) };
  },
};

export const fillArea: Skill = {
  def: {
    name: 'fillArea',
    description:
      'Fill a box-shaped region with one block — the workhorse for floors, walls, roofs and solid ' +
      'shapes. Give the two opposite corners (inclusive). Set hollow=true to place only the outer ' +
      'shell (walls + floor + ceiling, hollow inside) — use that for rooms. Cells already holding ' +
      'the right block are skipped, so you can safely call it again to finish a big fill. Requires ' +
      'building mode and enough of the block in your inventory.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'Block to place, e.g. cobblestone, oak_planks.' },
        x1: { type: 'integer', description: 'First corner X.' },
        y1: { type: 'integer', description: 'First corner Y.' },
        z1: { type: 'integer', description: 'First corner Z.' },
        x2: { type: 'integer', description: 'Opposite corner X.' },
        y2: { type: 'integer', description: 'Opposite corner Y.' },
        z2: { type: 'integer', description: 'Opposite corner Z.' },
        hollow: { type: 'boolean', description: 'If true, only the outer shell (default false = solid).' },
      },
      required: ['block', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const block = String(args.block ?? '').toLowerCase().trim();
    if (!block) return { ok: false, message: 'Tell me which block to fill with.' };
    const min = new Vec3(Math.min(num(args.x1), num(args.x2)), Math.min(num(args.y1), num(args.y2)), Math.min(num(args.z1), num(args.z2)));
    const max = new Vec3(Math.max(num(args.x1), num(args.x2)), Math.max(num(args.y1), num(args.y2)), Math.max(num(args.z1), num(args.z2)));
    const hollow = args.hollow === true;

    const cells: Vec3[] = [];
    for (let y = min.y; y <= max.y; y++) {
      for (let x = min.x; x <= max.x; x++) {
        for (let z = min.z; z <= max.z; z++) {
          const onShell = x === min.x || x === max.x || y === min.y || y === max.y || z === min.z || z === max.z;
          if (hollow && !onShell) continue;
          cells.push(new Vec3(x, y, z));
        }
      }
    }
    const need = cells.length;
    const have = countItem(bot, block);
    if (have === 0) return { ok: false, message: `I have no ${block} — gather or craft some before filling.` };
    const note = have < need ? ` (I only have ${have} of ~${need} needed — will place what I can, then ask for more)` : '';
    const res = await buildCells(bot, cells, block, ctx);
    return { ...res, message: res.message + note };
  },
};

export const buildLine: Skill = {
  def: {
    name: 'buildLine',
    description:
      'Place a straight line of one block from one point to another (a beam, pillar, edge or path). ' +
      'Walks the 3D line between the two inclusive endpoints. Requires building mode and the block ' +
      'in your inventory.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'Block to place.' },
        x1: { type: 'integer', description: 'Start X.' },
        y1: { type: 'integer', description: 'Start Y.' },
        z1: { type: 'integer', description: 'Start Z.' },
        x2: { type: 'integer', description: 'End X.' },
        y2: { type: 'integer', description: 'End Y.' },
        z2: { type: 'integer', description: 'End Z.' },
      },
      required: ['block', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const block = String(args.block ?? '').toLowerCase().trim();
    if (!block) return { ok: false, message: 'Tell me which block to place.' };
    const a = new Vec3(num(args.x1), num(args.y1), num(args.z1));
    const b = new Vec3(num(args.x2), num(args.y2), num(args.z2));
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    const cells: Vec3[] = [];
    const seen = new Set<string>();
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const p = new Vec3(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t), Math.round(a.z + (b.z - a.z) * t));
      const k = `${p.x},${p.y},${p.z}`;
      if (!seen.has(k)) { seen.add(k); cells.push(p); }
    }
    if (countItem(bot, block) === 0) return { ok: false, message: `I have no ${block} to place.` };
    return buildCells(bot, cells, block, ctx);
  },
};

export const placeBlock: Skill = {
  def: {
    name: 'placeBlock',
    description:
      'Place a single block you are holding from inventory into the world. Give x,y,z to put it at a ' +
      'specific spot (the bot walks into reach first); omit the coordinates to just set it down in ' +
      'a clear spot right next to you. The spot must be empty and have an adjacent block (or the ' +
      'ground) to build against. For walls/floors/large shapes use fillArea instead.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Block to place, e.g. cobblestone or oak_planks.' },
        x: { type: 'integer', description: 'Target X (optional — omit to place next to the bot).' },
        y: { type: 'integer', description: 'Target Y (optional).' },
        z: { type: 'integer', description: 'Target Z (optional).' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },

  async run(bot, args, ctx) {
    const name = String(args.item ?? '').toLowerCase().trim();
    if (!name) return { ok: false, message: 'Tell me which block to place.' };

    const item = findItem(bot, name);
    if (!item) return { ok: false, message: `I don't have any ${name} to place.` };
    try {
      await bot.equip(item, 'hand');
    } catch (err) {
      return { ok: false, message: `Couldn't hold ${item.name}: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (hasCoords(args, ['x', 'y', 'z'])) {
      const target = new Vec3(num(args.x), num(args.y), num(args.z));
      if (bot.entity.position.distanceTo(target) > 3.5) {
        await walkToward(bot, () => target, 2, ctx.reflex, ctx.shouldStop);
      }
      const ok = await tryPlaceAt(bot, target);
      if (ok && ctx.building?.enabled) ctx.building.session.record(target, item.name);
      return ok
        ? { ok: true, message: `Placed ${item.name} at ${target.x}, ${target.y}, ${target.z}.` }
        : {
            ok: false,
            message: `Couldn't place ${item.name} at ${target.x}, ${target.y}, ${target.z} — the spot is occupied or has no block to build against.`,
          };
    }

    // No coordinates: drop it in the first clear cell beside me (foot level, then head level).
    const feet = bot.entity.position.floored();
    const candidates: Vec3[] = [
      feet.offset(1, 0, 0),
      feet.offset(-1, 0, 0),
      feet.offset(0, 0, 1),
      feet.offset(0, 0, -1),
      feet.offset(1, 1, 0),
      feet.offset(-1, 1, 0),
      feet.offset(0, 1, 1),
      feet.offset(0, 1, -1),
    ];
    for (const target of candidates) {
      if (await tryPlaceAt(bot, target)) {
        if (ctx.building?.enabled) ctx.building.session.record(target, item.name);
        return { ok: true, message: `Placed ${item.name} at ${target.x}, ${target.y}, ${target.z} (next to me).` };
      }
    }
    return { ok: false, message: `Couldn't find a clear spot next to me to place ${item.name}.` };
  },
};

/** Renders a cube of real blocks as per-layer ASCII maps (with a legend) when it's small enough to
 *  be readable, else a plain tally. This is the bot's structural "sight": exact names and positions
 *  straight from the world, no vision model needed. */
function describeArea(bot: Bot, center: Vec3, r: number): string {
  const min = center.offset(-r, -r, -r);
  const max = center.offset(r, r, r);
  const span = 2 * r + 1;

  // Assign a stable legend symbol to each distinct non-air block found.
  const SYMBOLS = '#$%&*+=@OXTHKLMNPQRSUVWYZ0123456789abcdefghijkmnopqrstuvwxyz';
  const symbolFor = new Map<string, string>();
  const tally = new Map<string, number>();
  const grid: Record<number, string[][]> = {};

  for (let y = max.y; y >= min.y; y--) {
    const rows: string[][] = [];
    for (let z = min.z; z <= max.z; z++) {
      const row: string[] = [];
      for (let x = min.x; x <= max.x; x++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        const nm = b?.name ?? 'unknown';
        if (!b || nm === 'air' || nm === 'cave_air' || nm === 'void_air') {
          row.push('.');
          continue;
        }
        tally.set(nm, (tally.get(nm) ?? 0) + 1);
        let sym = symbolFor.get(nm);
        if (!sym) {
          sym = SYMBOLS[symbolFor.size] ?? '?';
          symbolFor.set(nm, sym);
        }
        row.push(sym);
      }
      rows.push(row);
    }
    grid[y] = rows;
  }

  if (tally.size === 0) return `Scanned (${center.x},${center.y},${center.z}) r=${r}: all air/empty.`;

  const legend = [...symbolFor.entries()].map(([nm, s]) => `${s}=${nm}`).join('  ');
  const head = `Scan around (${center.x},${center.y},${center.z}), radius ${r}. Grid: rows are +Z (south) down, cols are +X (east) right. '.'=air.\nLegend: ${legend}`;

  // For a small enough area, draw each non-empty layer; otherwise just the tally (token budget).
  if (span <= 13) {
    const layers: string[] = [];
    for (let y = max.y; y >= min.y; y--) {
      const rows = grid[y];
      if (rows.every((r2) => r2.every((c) => c === '.'))) continue; // skip empty layers
      layers.push(`y=${y}:\n` + rows.map((r2) => r2.join('')).join('\n'));
    }
    return `${head}\n\n${layers.join('\n\n')}`;
  }
  const counts = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c}x ${n}`).join(', ');
  return `${head}\n(Area too large to map; tally) ${counts}.`;
}
