import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import 'dotenv/config';

/**
 * Stage 1 config shape. Kept intentionally small; grows (with zod validation and
 * provider routing) in later stages.
 */
export interface AppConfig {
  server: {
    host: string;
    port: number;
    auth: 'offline' | 'microsoft';
    /** undefined => let mineflayer auto-detect the server version. */
    version: string | undefined;
  };
  agent: {
    username: string;
    brain: string;
  };
  conversation: {
    maxMessages: number;
    keepRecent: number;
  };
  viewer: {
    port: number;
  };
}

export function loadConfig(path = 'config/default.yaml'): AppConfig {
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, any>;

  const auth = raw.server?.auth === 'microsoft' ? 'microsoft' : 'offline';
  const versionRaw = raw.server?.version;
  const version = typeof versionRaw === 'string' && versionRaw.trim() !== '' ? versionRaw : undefined;

  return {
    server: {
      host: raw.server?.host ?? '127.0.0.1',
      port: Number(raw.server?.port ?? 25565),
      auth,
      version,
    },
    agent: {
      username: raw.agent?.username ?? 'Steve_AI',
      brain: raw.agent?.brain ?? 'brains/default',
    },
    conversation: {
      maxMessages: Number(raw.conversation?.maxMessages ?? 16),
      keepRecent: Number(raw.conversation?.keepRecent ?? 6),
    },
    viewer: {
      port: Number(raw.viewer?.port ?? 3000),
    },
  };
}
