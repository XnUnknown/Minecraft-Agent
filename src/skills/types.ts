import type { Bot } from 'mineflayer';
import type { ToolDef } from '../llm/types';

/** Context passed to a skill at execution time. */
export interface SkillContext {
  /** Username of the player who issued the current goal, if any. */
  requestedBy?: string;
}

/** A callable agent capability: its tool schema + implementation. */
export interface Skill {
  def: ToolDef;
  /** Runs the skill; returns a short human-readable result string. */
  run(bot: Bot, args: Record<string, unknown>, ctx: SkillContext): Promise<string>;
}
