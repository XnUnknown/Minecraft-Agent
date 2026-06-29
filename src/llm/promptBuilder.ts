import type { ToolDef } from './types';
import { buildStaticPrompt } from './contextLoader';

/** System prompt for providers using NATIVE tool calling (OpenAI / Claude / gpt-oss). The prose
 *  lives in editable markdown under `context/native/` (loaded once + cached); `codeExecution`
 *  includes the `*.code.md` sandbox section only when the runCode tool is enabled. */
export function buildSystemPrompt(botName: string, codeExecution = false): string {
  return buildStaticPrompt('native', { botName, codeExecution });
}

/** System prompt for JSON-mode models (no native tool calling, e.g. Gemma). The prose lives in
 *  editable markdown under `context/json/` (loaded once + cached); the tool catalog is rendered
 *  from the live `tools` and substituted for the `{{tools}}` placeholder. */
export function buildJsonSystemPrompt(botName: string, tools: ToolDef[], codeExecution = false): string {
  const catalog = tools
    .map((t) => {
      const props = Object.entries(t.parameters.properties)
        .map(([k, v]) => `${k}:${v.type}${t.parameters.required?.includes(k) ? '*' : ''}`)
        .join(', ');
      return `- ${t.name}: ${t.description} | args: ${props || 'none'}`;
    })
    .join('\n');

  return buildStaticPrompt('json', { botName, tools: catalog, codeExecution });
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
