import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage, ToolDef } from '../llm/types';

/** Where the latest LLM context gets written. Overwritten every turn, so the file always shows
 *  exactly what the planner was last given. Open it in any markdown viewer to watch live. */
const FILE = 'data/context-dump.md';

/**
 * Dumps the full prompt the planner is about to receive (system prompt + every message + the
 * tool list) to a markdown file, with a rough token estimate. Purely a debug aid — wrapped so a
 * failure here can never break the agent. Disable by setting CONTEXT_DUMP=off.
 */
export function dumpContext(opts: { system: string; messages: ChatMessage[]; tools?: ToolDef[]; label?: string }): void {
  if (process.env.CONTEXT_DUMP === 'off') return;
  try {
    const { system, messages, tools = [], label } = opts;
    const chars = system.length + messages.reduce((n, m) => n + m.content.length, 0);
    const out: string[] = [];
    out.push(`# LLM context dump${label ? ` — ${label}` : ''}`);
    out.push(`_${new Date().toISOString()}_`);
    out.push('');
    out.push(`- Messages: **${messages.length}**`);
    out.push(`- Registered tools: **${tools.length}**`);
    out.push(`- Approx size: **${chars.toLocaleString()} chars (~${Math.round(chars / 4).toLocaleString()} tokens)**`);
    out.push('');
    out.push('---');
    out.push('## System prompt');
    out.push('```text');
    out.push(system);
    out.push('```');
    out.push('');
    if (tools.length) {
      out.push(`## Tools (${tools.length})`);
      out.push(tools.map((t) => `- \`${t.name}\``).join('\n'));
      out.push('');
    }
    out.push('---');
    out.push(`## Messages (${messages.length}) — oldest first`);
    messages.forEach((m, i) => {
      out.push('');
      out.push(`### [${i + 1}] ${m.role}`);
      out.push('```text');
      out.push(m.content);
      out.push('```');
    });
    out.push('');

    if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, out.join('\n'), 'utf8');
  } catch {
    /* a debug dump must never break the agent loop */
  }
}
