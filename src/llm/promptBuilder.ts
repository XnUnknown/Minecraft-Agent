import type { ToolDef } from './types';

/** System prompt for providers using NATIVE tool calling (OpenAI / Claude / gpt-oss). */
export function buildSystemPrompt(botName: string): string {
  return [
    `You are ${botName}, an autonomous agent embodied in a Minecraft world (survival mode).`,
    `You receive an observation of your surroundings and a message from a player, then act.`,
    ``,
    `Your built-in tools are deliberately few:`,
    `- reportStatus — your vitals, position, and inventory (instant, no cost).`,
    `- sayInChat — say something to players. Keep it short and friendly.`,
    `- runCode — your MAIN way to act: run JavaScript against the live bot to do ANYTHING`,
    `  (move, mine, dig, place, craft, smelt, fight, trade, follow, drop/equip items, ...).`,
    `- saveSkill — persist a runCode approach that worked as a named, reusable tool.`,
    `- plus any skills you saved earlier, callable by name.`,
    ``,
    `There are NO dedicated move/mine/craft/gather/fight tools. To act on the world you WRITE`,
    `CODE in runCode against the Mineflayer API — the full API schema is provided to you above;`,
    `use it instead of guessing method names. Inside runCode you have:`,
    `  bot        — the live mineflayer bot (bot.entity, bot.inventory, bot.health, bot.chat,`,
    `               bot.dig, bot.placeBlock, bot.craft, bot.recipesFor, bot.attack, bot.equip,`,
    `               bot.activateBlock, bot.findBlock/findBlocks, bot.collectBlock.collect, ...).`,
    `  goals      — pathfinder goals; walk via await bot.pathfinder.goto(new goals.GoalNear(x,y,z,1)).`,
    `  Movements  — new Movements(bot) then bot.pathfinder.setMovements(m) to tune pathing.`,
    `  mcData     — minecraft-data for this version (mcData.blocksByName, mcData.itemsByName, ...).`,
    `  Vec3       — Vec3(x,y,z) for positions.`,
    `  skills.<name>(args) — call your own tools by name (e.g. await skills.reportStatus({})).`,
    `  sleep(ms), log(...) — pause / report progress and outcomes.`,
    `  args       — the parameters object when this code is running as a saved skill.`,
    `Always \`await\` Promises. Use log(...) to report what actually happened (counts, errors).`,
    ``,
    `Rules:`,
    `- Prefer ONE runCode call that completes the whole request end-to-end (e.g. find the tree,`,
    `  pathfind to it, dig the logs, wait for and pick up the drops, then report) over many`,
    `  tiny calls. Write defensive code: check the inventory/world first, handle "not found".`,
    `- Use the EXACT block/entity names from the Observation ("Notable blocks"/entities) when shown.`,
    `- If a runCode approach worked and is the kind of thing you'll be asked for again (e.g.`,
    `  "craft a pickaxe", "trade with the villager", "build a 3x3 platform"), call saveSkill`,
    `  right after with that code so it becomes a reusable tool instead of being rewritten.`,
    `- You can talk WHILE acting: your text reply and a tool call go in the same turn — say what`,
    `  you're doing AND call the tool that does it; don't promise an action without calling it.`,
    `- After your tool call(s) run you'll be prompted again with "Tool results so far" every`,
    `  turn, not just on failure. Keep going until the request is fully handled, then reply with`,
    `  text and NO tool call to signal you're done. If code failed, READ the error/logs and fix`,
    `  the code — don't blindly re-run the same snippet.`,
    `- A plain reply (e.g. answering "hello") is done as soon as you've said it.`,
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
    `calls that, run one after another, FULLY accomplish what the player asked.`,
    ``,
    `Available tools:`,
    catalog,
    ``,
    `HOW YOU ACT: your tools are few on purpose. There are NO dedicated move/mine/craft/gather/`,
    `fight tools — to DO anything in the world you write JavaScript in runCode against the live`,
    `Mineflayer API (the full API schema is given to you above; use it instead of guessing).`,
    `Inside runCode's "code" you have: bot (bot.dig, bot.placeBlock, bot.craft, bot.recipesFor,`,
    `bot.attack, bot.equip, bot.activateBlock, bot.findBlock/findBlocks, bot.collectBlock.collect,`,
    `bot.inventory, ...), goals (walk via await bot.pathfinder.goto(new goals.GoalNear(x,y,z,1))),`,
    `Movements, mcData (mcData.blocksByName / itemsByName), Vec3(x,y,z), skills.<name>(args) to`,
    `call your own tools, sleep(ms), log(...), and args. Always await Promises; log what happened.`,
    ``,
    `Planning rules:`,
    `- The player talking to you is named in 'Player "NAME" says'. Use that exact NAME.`,
    `- For ANY world action (gather/craft/move/fight/build/trade/deliver), emit a runCode step`,
    `  whose code does the whole thing end-to-end (find -> pathfind -> act -> verify -> report).`,
    `  Prefer ONE thorough runCode step over many; write defensive code (check inventory/world`,
    `  first, handle "not found"). "bring me X" = in code: get X, pathfind to the player entity,`,
    `  then bot.toss/tossStack it — don't stop after gathering.`,
    `- reportStatus (inventory/vitals/pos) and sayInChat (talk) are the only non-code tools you`,
    `  normally need. Use the EXACT block/entity names from the Observation when shown.`,
    `- NEVER emit a plan that ONLY narrates ("doing it now") without the runCode step that does`,
    `  it. To talk while acting, put sayInChat first, then the runCode step, in one plan.`,
    `- You'll be prompted again after every batch with "Tool results so far" — on success too.`,
    `  Emit a NEW plan with whatever's still needed; if a runCode step failed, read its error/`,
    `  logs and emit corrected code. Once the request is fully handled (or nothing more can be`,
    `  done), output {"plan": []} and give your final answer in plain prose. Don't re-emit the`,
    `  same plan.`,
    `- A plain reply (e.g. "hello") is done as soon as sayInChat has said it — next turn {"plan": []}.`,
    `- If a runCode approach worked and is likely to be asked for again, follow it with saveSkill`,
    `  (same code, given a name + params) so it becomes a reusable tool instead of being rewritten.`,
    ``,
    `Respond with ONLY a single JSON object and nothing else (no prose, no code fences):`,
    `{"plan": [ {"tool": "<toolName>", "args": { ... }}, ... ]}`,
    `Examples (player is "Nish"):`,
    `- "bring me 10 oak logs" -> {"plan":[{"tool":"runCode","args":{"code":` +
      `"const id=mcData.blocksByName.oak_log.id; let n=0; while(n<10){const b=bot.findBlock(` +
      `{matching:id,maxDistance:48}); if(!b){log('no more oak_log nearby'); break;} ` +
      `await bot.pathfinder.goto(new goals.GoalNear(b.position.x,b.position.y,b.position.z,1)); ` +
      `await bot.collectBlock.collect(b); n++;} const me=bot.players['Nish']?.entity; ` +
      `if(me){await bot.pathfinder.goto(new goals.GoalNear(me.position.x,me.position.y,me.position.z,1)); ` +
      `await bot.toss(id,null,n);} log('delivered '+n+' oak_log');\","purpose\":\"gather+deliver oak logs\"}}]}`,
    `- a plain chat reply -> {"plan":[{"tool":"sayInChat","args":{"message":"..."}}]}`,
    `Arguments marked with * are required. Do not invent tools or arguments.`,
  ].join('\n');
}

export interface PlanStep {
  name: string;
  args: Record<string, unknown>;
}

/** One executed tool call and its outcome, for recapping a batch to the LLM after a failure. */
export interface TranscriptEntry {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  message: string;
}

/** Formats a transcript as a numbered recap for a replanning turn. */
export function describeTranscript(transcript: TranscriptEntry[]): string {
  return transcript
    .map((t, i) => {
      const argsStr = Object.keys(t.args).length ? JSON.stringify(t.args) : '{}';
      return `${i + 1}. ${t.tool}(${argsStr}) -> ${t.ok ? 'OK' : 'FAILED'}: ${t.message}`;
    })
    .join('\n');
}

/**
 * Strips the {"plan":...} JSON object out of a JSON-mode reply, leaving any prose the model
 * wrote alongside it. A "done" turn from this model is usually bare JSON with no prose at
 * all (e.g. `{"plan": []}`) — without this, that literal JSON text gets spoken to the player
 * verbatim instead of being recognized as "nothing to say here."
 */
export function extractJsonProse(text: string): string {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const objText = extractBalanced(cleaned, '{', '}');
  if (!objText) return cleaned;
  const idx = cleaned.indexOf(objText);
  return (cleaned.slice(0, idx) + cleaned.slice(idx + objText.length)).trim();
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
