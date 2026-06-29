import type { Bot } from 'mineflayer';
import type { Skill, SkillContext, SkillResult } from './types';
import type { ToolDef } from '../llm/types';
import { reportStatus } from './actions/status';
import { sayInChat } from './actions/chat';
import { runCode, saveSkill, loadStoredSkills, buildDynamicSkill } from './actions/code';
import { logger } from '../util/logger';

/**
 * The deliberately tiny set of built-in tools. Everything else the bot can do is expressed by
 * the model writing JavaScript against the full mineflayer API inside `runCode` (see the API
 * schema injected into the system prompt), and optionally persisted with `saveSkill`. We keep
 * only what's either cheaper/safer as a native primitive (instant status with no LLM, plain
 * chat) or what bootstraps the sandbox itself (runCode, saveSkill). To add a NEW built-in, write
 * a `Skill` under `actions/` and add it here — but prefer a saved skill unless it truly needs to
 * live outside the sandbox.
 */
const SKILLS: Skill[] = [
  reportStatus,
  sayInChat,
  runCode,
  saveSkill,
];

export class SkillRegistry {
  private map = new Map<string, Skill>();
  /** Names of skills loaded from data/skills/*.json or registered live via saveSkill —
   *  tracked separately so goalRunner can tell "ran generated code" apart from a built-in. */
  private dynamicNames = new Set<string>();

  constructor() {
    for (const s of SKILLS) this.map.set(s.def.name, s);
    for (const stored of loadStoredSkills()) {
      if (this.map.has(stored.name)) {
        logger.warn(`Saved skill "${stored.name}" collides with a built-in tool name — skipped.`);
        continue;
      }
      this.map.set(stored.name, buildDynamicSkill(stored));
      this.dynamicNames.add(stored.name);
      logger.info(`Loaded saved skill "${stored.name}".`);
    }
  }

  /** Tool schemas to send to the LLM — includes dynamically loaded/saved skills. */
  toolDefs(): ToolDef[] {
    return [...this.map.values()].map((s) => s.def);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  /** Registers a new skill immediately (used by saveSkill so it's callable this session). */
  registerDynamic(skill: Skill): void {
    this.map.set(skill.def.name, skill);
    this.dynamicNames.add(skill.def.name);
  }

  /** True for a skill loaded from data/skills/*.json or saved live this session. */
  isDynamic(name: string): boolean {
    return this.dynamicNames.has(name);
  }

  async execute(
    bot: Bot,
    name: string,
    args: Record<string, unknown>,
    ctx: SkillContext,
  ): Promise<SkillResult> {
    const skill = this.map.get(name);
    if (!skill) return { ok: false, message: `Unknown tool "${name}".` };
    try {
      const result = await skill.run(bot, args, { ...ctx, registry: this });
      logger.info(`[tool] ${name}(${JSON.stringify(args)}) -> ${result.ok ? 'OK' : 'FAILED'}: ${result.message}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[tool] ${name}(${JSON.stringify(args)}) -> FAILED: ${msg}`);
      return { ok: false, message: `Tool ${name} failed: ${msg}` };
    }
  }
}
