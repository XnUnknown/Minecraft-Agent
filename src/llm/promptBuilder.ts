import type { ToolDef } from './types';

/** System prompt for providers using NATIVE tool calling (OpenAI / Claude / gpt-oss). */
export function buildSystemPrompt(botName: string): string {
  return [
    `You are ${botName}, an autonomous agent embodied in a Minecraft world (survival mode).`,
    `You receive an observation of your surroundings and a message from a player.`,
    `Decide what to do and call the appropriate tool. Use sayInChat to talk.`,
    `Rules:`,
    `- Prefer a concrete tool action over only talking when the player asks you to do something.`,
    `- Keep chat messages short and friendly.`,
    `- Only use the tools provided; never invent tools or arguments.`,
    `- The Observation lists exact block names actually nearby ("Notable blocks") and exact`,
    `  entity names — use those exact names as tool arguments instead of guessing a generic`,
    `  variant (e.g. dark_oak_log, not oak_log, if that's what's listed).`,
  ].join('\n');
}

/** System prompt for JSON-mode models (no native tool calling, e.g. Gemma). */
export function buildJsonSystemPrompt(botName: string, tools: ToolDef[]): string {
  const catalog = tools
    .map((t) => {
      const props = Object.entries(t.parameters.properties)
        .map(([k, v]) => `${k}:${v.type}${t.parameters.required?.includes(k) ? '*' : ''}`)
        .join(', ');
      return `- ${t.name}: ${t.description} | args: ${props || 'none'}`;
    })
    .join('\n');

  return [
    `You are ${botName}, an autonomous agent in a Minecraft world (survival mode).`,
    `You are given an observation and a player's message. Produce an ordered PLAN of tool`,
    `calls that, run one after another, FULLY accomplish what the player asked — think the`,
    `whole job through, not just the first step.`,
    ``,
    `Available tools:`,
    catalog,
    ``,
    `Planning rules:`,
    `- The player talking to you is named in 'Player "NAME" says'. Use that exact NAME for`,
    `  playerName / who to deliver to.`,
    `- "bring/get/fetch me X" means: gather X, THEN goToPlayer(NAME), THEN tossItem(X). Never`,
    `  stop after gathering — always return and hand it over.`,
    `- A request can be several tasks ("get wood and then kill 2 zombies"): include EVERY task`,
    `  as steps, in the order asked.`,
    `- "follow me / come with me / stay with me" = followPlayer (keeps following). A one-off`,
    `  "come here" = goToPlayer.`,
    `- Pick sensible counts and block names (logs are oak_log/birch_log/etc.).`,
    `- The Observation's "Notable blocks" and entity lists show EXACT names actually nearby —`,
    `  use those exact names (e.g. dark_oak_log, polar_bear) instead of a generic guess; a`,
    `  close variant will still be accepted if the exact one isn't available, but the exact`,
    `  name finds it faster.`,
    ``,
    `Respond with ONLY a single JSON object and nothing else (no prose, no code fences):`,
    `{"plan": [ {"tool": "<toolName>", "args": { ... }}, ... ]}`,
    `Examples (player is "Nish"):`,
    `- "bring me 10 oak logs and kill the monsters" ->`,
    `  {"plan":[{"tool":"collectBlock","args":{"blockType":"oak_log","count":10}},` +
      `{"tool":"goToPlayer","args":{"playerName":"Nish"}},` +
      `{"tool":"tossItem","args":{"item":"oak_log"}},` +
      `{"tool":"attackNearestMob","args":{"count":3}}]}`,
    `- "follow me" -> {"plan":[{"tool":"followPlayer","args":{"playerName":"Nish"}}]}`,
    `- a plain chat reply -> {"plan":[{"tool":"sayInChat","args":{"message":"..."}}]}`,
    `Arguments marked with * are required. Do not invent tools or arguments.`,
  ].join('\n');
}

export interface PlanStep {
  name: string;
  args: Record<string, unknown>;
}

/** Extracts a {"tool","args"} action from a JSON-mode model's text reply. */
export function parseJsonToolCall(text: string): PlanStep | null {
  const steps = parseJsonPlan(text);
  return steps[0] ?? null;
}

/**
 * Extracts an ordered plan of tool calls from a JSON-mode model's reply. Accepts
 * `{"plan":[...]}`, a bare `[...]` array, or a single `{"tool","args"}` object.
 */
export function parseJsonPlan(text: string): PlanStep[] {
  if (!text) return [];
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();

  const arrayText = cleaned[0] === '[' ? extractBalanced(cleaned, '[', ']') : null;
  if (arrayText) {
    try {
      return toSteps(JSON.parse(arrayText));
    } catch {
      /* fall through to object parse */
    }
  }

  const objText = extractBalanced(cleaned, '{', '}');
  if (objText) {
    try {
      const obj = JSON.parse(objText) as { plan?: unknown; tool?: unknown; args?: unknown };
      if (Array.isArray(obj.plan)) return toSteps(obj.plan);
      if (typeof obj.tool === 'string') return toSteps([obj]);
    } catch {
      /* ignore */
    }
  }
  return [];
}

function toSteps(arr: unknown): PlanStep[] {
  if (!Array.isArray(arr)) return [];
  const steps: PlanStep[] = [];
  for (const raw of arr) {
    const s = raw as { tool?: unknown; args?: unknown };
    if (s && typeof s.tool === 'string') {
      steps.push({ name: s.tool, args: s.args && typeof s.args === 'object' ? (s.args as Record<string, unknown>) : {} });
    }
  }
  return steps;
}

/** Returns the first balanced open..close substring, or null. */
function extractBalanced(s: string, open: string, close: string): string | null {
  const start = s.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
