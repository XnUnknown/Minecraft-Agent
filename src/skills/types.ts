import type { Bot } from 'mineflayer';
import type { ToolDef } from '../llm/types';
import type { ReflexLayer } from '../reflex/ReflexLayer';

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
}

/** A callable agent capability: its tool schema + implementation. */
export interface Skill {
  def: ToolDef;
  /** Runs the skill; returns a short human-readable result string. */
  run(bot: Bot, args: Record<string, unknown>, ctx: SkillContext): Promise<string>;
}
