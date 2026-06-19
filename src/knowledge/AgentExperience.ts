import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../util/logger';

const FILE_PATH = 'data/agent_experience.md';
const HEADER =
  '# Agent experience\n\n' +
  'Tasks completed using generated code (runCode) or a saved skill, logged at runtime so\n' +
  'future plans can see what already worked instead of re-deriving it from scratch. Stand-in\n' +
  'for the planned RAG/vector memory system, same role CraftingExperience.ts plays for recipes.\n';

let cachedBody = '';
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(FILE_PATH)) {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    writeFileSync(FILE_PATH, HEADER, 'utf8');
    cachedBody = HEADER;
    return;
  }
  cachedBody = readFileSync(FILE_PATH, 'utf8');
}

/** Raw file content for prompt injection, or '' if nothing's been logged yet. */
export function contextBlock(): string {
  ensureLoaded();
  return cachedBody.trim() === HEADER.trim() ? '' : cachedBody.trim();
}

/** Appends one completed-task entry. Always adds (no dedup) — each task description is
 *  free-form natural language, unlike CraftingExperience's one-entry-per-item-name keying. */
export function recordExperience(task: string, approach: string, outcome: string): void {
  ensureLoaded();
  const section = `\n## ${task}\n- Approach: ${approach}\n- Outcome: ${outcome}\n`;
  cachedBody += section;
  try {
    writeFileSync(FILE_PATH, cachedBody, 'utf8');
  } catch (err) {
    logger.warn(`Failed to persist agent experience: ${err instanceof Error ? err.message : String(err)}`);
  }
}
