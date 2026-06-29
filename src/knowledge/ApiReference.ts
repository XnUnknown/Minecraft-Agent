import { existsSync, readFileSync } from 'node:fs';

/** Condensed-but-complete mineflayer/pathfinder API surface, generated from the vendored docs
 *  (scripts regenerate it from docs/mineflayer/*.md). Injected into the planner's system prompt
 *  so sandbox code can use the whole API without guessing at method names or signatures. */
const SCHEMA_PATH = 'docs/mineflayer/api-schema.md';

let cached: string | null = null;

/** The full API schema text (loaded + cached once). Empty string if the file is missing. */
export function apiReference(): string {
  if (cached !== null) return cached;
  cached = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, 'utf8') : '';
  return cached;
}

/** Prompt block form: the schema under a heading the planner is told to rely on. Empty when
 *  the schema file is absent, so withContext() simply omits it. */
export function apiReferenceBlock(): string {
  const text = apiReference().trim();
  return text ? `Mineflayer API you can call from runCode (full surface — await all Promises):\n${text}` : '';
}
