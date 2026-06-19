import type { Bot } from 'mineflayer';
import type { Skill, SkillContext } from './types';
import type { ToolDef } from '../llm/types';
import { goToPlayer, goToCoordinates, followPlayer, stopMoving } from './actions/navigation';
import { reportStatus } from './actions/status';
import { sayInChat } from './actions/chat';
import { collectBlock } from './actions/gathering';
import { attackNearestMob } from './actions/combat';
import { tossItem } from './actions/inventory';
import { craftItem } from './actions/crafting';
import { wearItem } from './actions/equipment';
import { tradeWithVillager } from './actions/trading';
import { logger } from '../util/logger';

/**
 * All registered skills. To add a new capability: write a `Skill` (def + run) in its own
 * file under `actions/`, import it here, and add it to this list.
 */
const SKILLS: Skill[] = [
  goToPlayer,
  goToCoordinates,
  followPlayer,
  stopMoving,
  reportStatus,
  sayInChat,
  collectBlock,
  attackNearestMob,
  tossItem,
  craftItem,
  wearItem,
  tradeWithVillager,
];

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
