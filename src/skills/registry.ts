import type { Bot } from 'mineflayer';
import type { Skill, SkillContext, SkillResult } from './types';
import type { ToolDef } from '../llm/types';
import { goToPlayer, goToCoordinates, followPlayer, stopMoving } from './actions/navigation';
import { reportStatus } from './actions/status';
import { sayInChat } from './actions/chat';
import { collectBlock } from './actions/gathering';
import { attackNearestMob } from './actions/combat';
import { tossItem } from './actions/inventory';
import { craftItem, getRecipe } from './actions/crafting';
import { wearItem } from './actions/equipment';
import { tradeWithVillager } from './actions/trading';
import { searchWide } from './actions/search';
import { messageAgent } from './actions/messaging';
import { runCode, saveSkill, loadStoredSkills, buildDynamicSkill } from './actions/code';
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
  getRecipe,
  wearItem,
  tradeWithVillager,
  searchWide,
  messageAgent,
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
