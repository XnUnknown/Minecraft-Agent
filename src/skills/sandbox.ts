import { compileFunction, createContext } from 'node:vm';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import type { SkillContext } from './types';
import type { SkillRegistry } from './registry';
import { withTimeout } from './util';

export interface SandboxResult {
  ok: boolean;
  message: string;
  logs: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SANDBOX_PARAMS = ['bot', 'args', 'skills', 'sleep', 'log', 'Vec3'] as const;

/**
 * Runs LLM-written JavaScript (Voyager-style: write code against a curated control API,
 * keep what works) inside a fresh `node:vm` context. This is a capability boundary, not a
 * hardened security sandbox — `require`/`process`/`fs`/`module` are simply never exposed,
 * so generated code can only reach what's handed to it below (the real bot, and every
 * other registered tool by name) — the same real-world capability every existing skill
 * already has, just composable in code instead of one tool call at a time.
 */
export async function runInSandbox(
  bot: Bot,
  code: string,
  args: Record<string, unknown>,
  ctx: SkillContext,
  registry: SkillRegistry,
  timeoutMs = 60000,
): Promise<SandboxResult> {
  const logs: string[] = [];
  const log = (...vals: unknown[]): void => {
    logs.push(vals.map((v) => (typeof v === 'string' ? v : stringify(v))).join(' '));
  };

  // Every registered tool (built-in or previously saved) callable as skills.<name>(args) —
  // routed through the registry's own execute() so nested calls get identical
  // [tool] name(args) -> OK/FAILED logging to a top-level plan step.
  const skillsBridge: Record<string, (a?: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>> = {};
  for (const def of registry.toolDefs()) {
    skillsBridge[def.name] = (a: Record<string, unknown> = {}) => registry.execute(bot, def.name, a, ctx);
  }

  const sandboxGlobals = {
    bot,
    args,
    skills: skillsBridge,
    sleep,
    log,
    Vec3,
    // LLMs default to console.log out of habit — alias it to the same captured log instead
    // of leaving it undefined (a fresh vm context has no console of its own).
    console: { log, warn: log, error: log },
  };
  const context = createContext(sandboxGlobals);

  try {
    // vm.compileFunction has no "async" option — wrap the body in an async IIFE so `await`
    // is valid inside the snippet and calling the compiled function returns a promise.
    const wrapped = `return (async () => {\n${code}\n})();`;
    const fn = compileFunction(wrapped, [...SANDBOX_PARAMS], { parsingContext: context });
    const returned = await withTimeout(
      Promise.resolve(fn(bot, args, skillsBridge, sleep, log, Vec3)),
      timeoutMs,
    );
    const tail = returned !== undefined ? ` Returned: ${stringify(returned)}.` : '';
    return { ok: true, message: `Code ran successfully.${tail}${logSuffix(logs)}`, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Code failed: ${msg}${logSuffix(logs)}`, logs };
  }
}

function logSuffix(logs: string[]): string {
  if (!logs.length) return '';
  return ` Logs: ${logs.join(' | ').slice(0, 1500)}`;
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
