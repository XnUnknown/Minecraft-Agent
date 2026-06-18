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
    `You are given an observation and a player's message. Choose exactly ONE action.`,
    ``,
    `Available tools:`,
    catalog,
    ``,
    `Respond with ONLY a single JSON object and nothing else (no prose, no code fences):`,
    `{"tool": "<toolName>", "args": { ... }}`,
    `For a conversational reply use: {"tool": "sayInChat", "args": {"message": "..."}}`,
    `Arguments marked with * are required. Do not invent tools or arguments.`,
  ].join('\n');
}

/** Extracts a {"tool","args"} action from a JSON-mode model's text reply. */
export function parseJsonToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const candidate = extractJsonObject(cleaned);
  if (!candidate) return null;
  try {
    const obj = JSON.parse(candidate) as { tool?: unknown; args?: unknown };
    if (obj && typeof obj.tool === 'string') {
      const args = obj.args && typeof obj.args === 'object' ? (obj.args as Record<string, unknown>) : {};
      return { name: obj.tool, args };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Returns the first balanced {...} object substring, or null. */
function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
