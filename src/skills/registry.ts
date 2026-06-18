import type { Bot } from 'mineflayer';
import type { Skill, SkillContext } from './types';
import type { ToolDef } from '../llm/types';
import { goToPlayer, goToCoordinates, stopMoving } from './actions/navigation';
import { reportStatus } from './actions/status';
import { sayInChat } from './actions/chat';
import { logger } from '../util/logger';

/** All registered skills. New capabilities are added here. */
const SKILLS: Skill[] = [goToPlayer, goToCoordinates, stopMoving, reportStatus, sayInChat];

export class SkillRegistry {
  private map = new Map<string, Skill>();

  constructor() {
    for (const s of SKILLS) this.map.set(s.def.name, s);
  }

  /** Tool schemas to send to the LLM. */
  toolDefs(): ToolDef[] {
    return SKILLS.map((s) => s.def);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  async execute(
    bot: Bot,
    name: string,
    args: Record<string, unknown>,
    ctx: SkillContext,
  ): Promise<string> {
    const skill = this.map.get(name);
    if (!skill) return `Unknown tool "${name}".`;
    try {
      const result = await skill.run(bot, args, ctx);
      logger.info(`skill ${name}(${JSON.stringify(args)}) -> ${result}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`skill ${name} failed: ${msg}`);
      return `Tool ${name} failed: ${msg}`;
    }
  }
}
