import type { Bot } from 'mineflayer';
import type { ToolDef } from '../llm/types';
import type { ReflexLayer } from '../reflex/ReflexLayer';
import type { SkillRegistry } from './registry';

/** Context passed to a skill at execution time. */
export interface SkillContext {
  /** Username of the player who issued the current goal, if any. */
  requestedBy?: string;
  /** The reflex layer, so combat skills can suppress its defense while they fight. */
  reflex?: ReflexLayer;
  /**
   * Returns true when the current task has been cancelled or pre-empted. Long-running
   * skills (walking, gathering, fighting) must poll this and bail out promptly so `stop`
   * and "do X now" actually interrupt them.
   */
  shouldStop?: () => boolean;
  /**
   * The registry running this skill, injected by `SkillRegistry.execute` itself. Lets
   * runCode/saveSkill call back into other tools by name (the sandbox bridge) and register
   * newly-saved skills live, without every skill needing it threaded through separately.
   */
  registry?: SkillRegistry;
}

/** Structured outcome of a skill run — lets the executor react to failure, not just guess from prose. */
export interface SkillResult {
  ok: boolean;
  message: string;
}

/** A callable agent capability: its tool schema + implementation. */
export interface Skill {
  def: ToolDef;
  /** Runs the skill; returns whether it succeeded plus a short human-readable message. */
  run(bot: Bot, args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult>;
}
