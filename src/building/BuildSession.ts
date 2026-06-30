import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

const keyOf = (p: { x: number; y: number; z: number }): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const parseKey = (k: string): Vec3 => {
  const [x, y, z] = k.split(',').map(Number);
  return new Vec3(x, y, z);
};

/**
 * The agent's structural memory of a build-in-progress. Without a vision model the bot can't
 * "see" what it has made, so instead it remembers every block it places here — position and
 * type — and can summarise that record back into the prompt. That textual model (bounding box,
 * per-type counts, per-layer breakdown, what was placed where) IS the bot's structural awareness:
 * it lets the planner reason about an evolving structure it can't look at.
 */
export class BuildSession {
  name = '';
  description = '';
  startedAt = 0;
  /** posKey -> block name we placed there. Our ground-truth log of the structure so far. */
  private placed = new Map<string, string>();

  start(name: string, description: string): void {
    this.name = name || 'structure';
    this.description = description || '';
    this.startedAt = Date.now();
    this.placed.clear();
  }

  /** Note a block we just placed (or re-placed) at a position. */
  record(pos: Vec3, block: string): void {
    this.placed.set(keyOf(pos), block);
  }

  /** Drop a position from the record (e.g. it got mined back out). */
  forget(pos: Vec3): void {
    this.placed.delete(keyOf(pos));
  }

  get size(): number {
    return this.placed.size;
  }

  /** Min/max corners over everything placed, or null if nothing has been placed yet. */
  bounds(): { min: Vec3; max: Vec3 } | null {
    if (this.placed.size === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const k of this.placed.keys()) {
      const p = parseKey(k);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxZ = Math.max(maxZ, p.z);
    }
    return { min: new Vec3(minX, minY, minZ), max: new Vec3(maxX, maxY, maxZ) };
  }

  /** How many of each block type we've placed, most-used first. */
  tallyByType(): Array<[string, number]> {
    const t = new Map<string, number>();
    for (const b of this.placed.values()) t.set(b, (t.get(b) ?? 0) + 1);
    return [...t.entries()].sort((a, b) => b[1] - a[1]);
  }

  /**
   * Cross-checks the record against the live world: how many recorded blocks are actually still
   * present. A gap means something we "remember" placing isn't there (griefed, never landed, or
   * mis-recorded), which is exactly what the planner needs to know to fix it.
   */
  verify(bot: Bot): { present: number; missing: Vec3[] } {
    const missing: Vec3[] = [];
    let present = 0;
    for (const [k, want] of this.placed) {
      const p = parseKey(k);
      const b = bot.blockAt(p);
      if (b && (b.name === want || b.name.includes(want) || want.includes(b.name))) present += 1;
      else missing.push(p);
    }
    return { present, missing };
  }

  /** A compact, prompt-ready description of the structure as the bot understands it so far. */
  summary(bot?: Bot): string {
    if (this.placed.size === 0) {
      return this.name
        ? `Build "${this.name}"${this.description ? ` — ${this.description}` : ''}: nothing placed yet.`
        : 'No build in progress yet.';
    }
    const b = this.bounds()!;
    const dims = `${b.max.x - b.min.x + 1}(x) x ${b.max.y - b.min.y + 1}(y) x ${b.max.z - b.min.z + 1}(z)`;
    const lines: string[] = [];
    lines.push(`Build "${this.name}"${this.description ? ` — ${this.description}` : ''}`);
    lines.push(`Placed ${this.placed.size} blocks. Footprint (${b.min.x},${b.min.y},${b.min.z})..(${b.max.x},${b.max.y},${b.max.z}), size ${dims}.`);
    lines.push('By type: ' + this.tallyByType().map(([n, c]) => `${c}x ${n}`).join(', ') + '.');

    // Per-layer counts give a sense of the vertical shape (floor heavy, walls, roof...).
    const perLayer = new Map<number, number>();
    for (const k of this.placed.keys()) {
      const y = parseKey(k).y;
      perLayer.set(y, (perLayer.get(y) ?? 0) + 1);
    }
    const layers = [...perLayer.entries()].sort((a, b2) => a[0] - b2[0]).map(([y, c]) => `y=${y}:${c}`);
    lines.push('Per layer: ' + layers.join(', ') + '.');

    if (bot) {
      const { present, missing } = this.verify(bot);
      if (missing.length) {
        const sample = missing.slice(0, 6).map((p) => `(${p.x},${p.y},${p.z})`).join(', ');
        lines.push(`Verified in world: ${present}/${this.placed.size} present. Missing ${missing.length}: ${sample}${missing.length > 6 ? ', ...' : ''}.`);
      } else {
        lines.push(`Verified in world: all ${present} present.`);
      }
    }
    return lines.join('\n');
  }
}

/**
 * Build-mode flag plus the live session, owned by the GoalRunner and threaded into every skill's
 * context. enter()/exit() flip the mode; building skills record placements into `session` so the
 * structural memory stays current, and the GoalRunner injects `session.summary()` into the prompt
 * each turn while the mode is on.
 */
export class BuildState {
  enabled = false;
  readonly session = new BuildSession();

  enter(name: string, description: string): void {
    this.enabled = true;
    // Only (re)start the session if there isn't already one going, so toggling mode mid-build
    // doesn't wipe the structural memory.
    if (this.session.size === 0 || name) this.session.start(name, description);
  }

  exit(): void {
    this.enabled = false;
  }
}
