import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Skill } from '../types';
import type { JSONSchema, JSONSchemaProperty } from '../../llm/types';
import { runInSandbox } from '../sandbox';
import { logger } from '../../util/logger';

export const SKILLS_DIR = 'data/skills';

/** On-disk shape of a model-saved skill. `params` is the same compact notation the model
 *  already sees in the JSON-mode tool catalog (promptBuilder.ts), e.g. "item:string*, count:integer". */
export interface StoredSkill {
  name: string;
  description: string;
  code: string;
  params: string;
}

export const runCode: Skill = {
  def: {
    name: 'runCode',
    description:
      'Run JavaScript against the live bot — this is the MAIN way to act (move, mine, dig, ' +
      'place, craft, smelt, fight, trade, follow, drop/equip items, build...). There are no ' +
      'dedicated action tools; do it here using the Mineflayer API (see the API schema in your ' +
      'system prompt). Available inside the code: bot (the live Mineflayer bot), goals ' +
      '(pathfinder: await bot.pathfinder.goto(new goals.GoalNear(x,y,z,1))), Movements, mcData ' +
      '(mcData.blocksByName/itemsByName), Vec3(x,y,z), skills.<toolName>(args) to call your own ' +
      'tools, sleep(ms), and log(...)/console.log(...) to report what happened. Always await ' +
      'Promises. If the approach worked and is the kind of thing you will be asked to do again, ' +
      'follow it with saveSkill so it becomes a reusable tool instead of rewriting the code.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript to run; may use await. Example: ' +
            'const id = mcData.blocksByName.oak_log.id; const b = bot.findBlock({matching:id, ' +
            'maxDistance:48}); if (b) { await bot.pathfinder.goto(new goals.GoalNear(b.position.x, ' +
            'b.position.y, b.position.z, 1)); await bot.collectBlock.collect(b); log("got a log"); }',
        },
        purpose: { type: 'string', description: 'Optional one-line note on what this code is trying to do.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const code = String(args.code ?? '');
    if (!code.trim()) return { ok: false, message: 'No code given.' };
    if (!ctx.registry) return { ok: false, message: 'Sandbox unavailable (no registry in context).' };

    const result = await runInSandbox(bot, code, {}, ctx, ctx.registry);
    const purpose = args.purpose ? String(args.purpose) : undefined;
    return { ok: result.ok, message: purpose ? `${purpose}: ${result.message}` : result.message };
  },
};

export const saveSkill: Skill = {
  def: {
    name: 'saveSkill',
    description:
      'Save working JavaScript (written the same way as for runCode) as a new, permanently ' +
      'reusable tool under a name, so future tasks can call it directly instead of ' +
      'rewriting the code. Use this right after a runCode approach worked, when it is the ' +
      'kind of thing likely to be asked for again — e.g. a "craftPickaxe" skill that gathers ' +
      'logs, makes planks/sticks, places a crafting table, and crafts the pickaxe; or a ' +
      '"fulfillVillagerTrade" skill that reads the villager trades, gathers what is missing, ' +
      'and completes the trade. The code can read its own parameters from the args object.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool name to register, e.g. fulfillVillagerTrade. Plain identifier, not already in use.',
        },
        description: { type: 'string', description: 'Description shown to you later when deciding to call this tool.' },
        code: {
          type: 'string',
          description:
            "The JavaScript body — same environment as runCode (bot, skills, sleep, log, " +
            "Vec3), plus an args object holding this skill's own parameters (e.g. args.item).",
        },
        params: {
          type: 'string',
          description:
            'Optional comma-separated parameter spec, e.g. "item:string*, count:integer" ' +
            '(* marks required; types: string, number, integer, boolean).',
        },
      },
      required: ['name', 'description', 'code'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const name = String(args.name ?? '').trim();
    const description = String(args.description ?? '').trim();
    const code = String(args.code ?? '');
    const params = args.params ? String(args.params) : '';

    if (!/^[a-zA-Z_]\w*$/.test(name)) {
      return { ok: false, message: `"${name}" isn't a valid tool name (letters/digits/underscore, can't start with a digit).` };
    }
    if (!ctx.registry) return { ok: false, message: 'Cannot save: no registry in context.' };
    if (ctx.registry.has(name)) return { ok: false, message: `A tool named "${name}" already exists — pick a different name.` };
    if (!code.trim()) return { ok: false, message: 'No code given.' };
    if (!description) return { ok: false, message: 'A description is required.' };

    const stored: StoredSkill = { name, description, code, params };
    try {
      mkdirSync(SKILLS_DIR, { recursive: true });
      writeFileSync(skillPath(name), JSON.stringify(stored, null, 2), 'utf8');
    } catch (err) {
      return { ok: false, message: `Couldn't save "${name}": ${err instanceof Error ? err.message : String(err)}` };
    }

    ctx.registry.registerDynamic(buildDynamicSkill(stored));
    return { ok: true, message: `Saved new tool "${name}" — it's usable right away.` };
  },
};

function skillPath(name: string): string {
  return `${SKILLS_DIR}/${name}.json`;
}

/** Loads every saved skill from disk, skipping any that fail to parse (logged, not fatal). */
export function loadStoredSkills(): StoredSkill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: StoredSkill[] = [];
  for (const file of readdirSync(SKILLS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(`${SKILLS_DIR}/${file}`, 'utf8')) as StoredSkill);
    } catch (err) {
      logger.warn(`Failed to load saved skill ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Turns a stored skill into a live `Skill` whose run() replays its code in the sandbox
 *  with the call's own args — used both at registry boot (loading data/skills/*.json) and
 *  immediately by saveSkill (so a newly-saved skill is callable in the same session). */
export function buildDynamicSkill(stored: StoredSkill): Skill {
  return {
    def: { name: stored.name, description: stored.description, parameters: parseParamsSpec(stored.params) },
    async run(bot, args, ctx) {
      if (!ctx.registry) return { ok: false, message: 'Sandbox unavailable (no registry in context).' };
      const result = await runInSandbox(bot, stored.code, args, ctx, ctx.registry);
      return { ok: result.ok, message: result.message };
    },
  };
}

/** Parses the compact "name:type*, name2:type" notation (same shorthand the JSON-mode
 *  prompt already renders for every built-in tool) into a JSONSchema for a saved skill. */
function parseParamsSpec(spec: string): JSONSchema {
  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = /^(\w+)\s*:\s*(string|number|integer|boolean)(\*)?$/.exec(trimmed);
    if (!m) continue;
    const [, paramName, type, star] = m;
    properties[paramName] = { type: type as JSONSchemaProperty['type'] };
    if (star) required.push(paramName);
  }
  return { type: 'object', properties, required: required.length ? required : undefined, additionalProperties: false };
}
