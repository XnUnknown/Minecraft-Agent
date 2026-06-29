import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/logger';

/**
 * Loads the PREDEFINED (static) part of the system prompt from editable markdown files under
 * `context/<mode>/`, so the prose can be tweaked/removed by hand without touching code. Disk is
 * read ONCE per mode and cached for the process — this is the "build the context one time from
 * that folder" half. The VOLATILE context (conversation summary, crafting/agent experience, the
 * live observation, peer-agent note) is assembled fresh every turn elsewhere (goalRunner's
 * withContext) and never passes through here.
 *
 * Conventions (see context/README.md):
 * - Files are concatenated in filename order, so prefix them 00-, 10-, 20- ... to order sections.
 * - `{{botName}}` and (json mode) `{{tools}}` are substituted at build time.
 * - A file named `*.code.md` is the sandbox/runCode section — included only when codeExecution is on.
 */
const CONTEXT_ROOT = 'context';

interface Section {
  file: string;
  /** Only included when sandbox code execution is enabled (filename ends in `.code.md`). */
  codeOnly: boolean;
  /** File body, trailing whitespace stripped so single-newline joins stay clean. */
  body: string;
}

const cache = new Map<string, Section[]>();

function readSections(mode: string): Section[] {
  const cached = cache.get(mode);
  if (cached) return cached;

  const dir = join(CONTEXT_ROOT, mode);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch (err) {
    logger.error(
      `Context folder "${dir}" is missing or unreadable — the ${mode} system prompt will be empty. ` +
        (err instanceof Error ? err.message : String(err)),
    );
    cache.set(mode, []);
    return [];
  }

  const sections: Section[] = files.map((file) => ({
    file,
    codeOnly: /\.code\.md$/i.test(file),
    body: readFileSync(join(dir, file), 'utf8').replace(/\s+$/, ''),
  }));
  cache.set(mode, sections);
  logger.info(`Loaded ${sections.length} static context section(s) from ${dir}.`);
  return sections;
}

export interface StaticPromptVars {
  botName: string;
  /** Pre-rendered tool catalog text — substituted for `{{tools}}` (json mode only). */
  tools?: string;
  /** When false, `*.code.md` sandbox sections are omitted. */
  codeExecution: boolean;
}

/** Assembles the static system prompt for a mode from its cached markdown sections. */
export function buildStaticPrompt(mode: 'native' | 'json', vars: StaticPromptVars): string {
  const text = readSections(mode)
    .filter((s) => vars.codeExecution || !s.codeOnly)
    .map((s) => s.body)
    .join('\n');
  return text
    .replace(/\{\{\s*botName\s*\}\}/g, vars.botName)
    .replace(/\{\{\s*tools\s*\}\}/g, vars.tools ?? '');
}

/** Drops the cache so edited context files are re-read (used by tooling/tests; a restart also works). */
export function clearContextCache(): void {
  cache.clear();
}
