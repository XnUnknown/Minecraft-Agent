import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import 'dotenv/config';

/** One bot's identity for multi-agent setups. `viewerPort` is pre-assigned per agent so
 *  running several in one process doesn't collide on the same POV viewer port. */
export interface AgentProfile {
  username: string;
  brain: string;
  viewerPort: number;
}

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
  /** Kept for backward compat — always equals agents[0]. Prefer `agents` for new code. */
  agent: {
    username: string;
    brain: string;
  };
  /** Every agent this process knows about. A single-entry list (the common case) behaves
   *  exactly like the old single-bot setup — no naming needed in chat. */
  agents: AgentProfile[];
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

  const defaultBrain = raw.agent?.brain ?? 'brains/default';
  const viewerPort = Number(raw.viewer?.port ?? 3000);

  // `agents:` (a list) is the multi-agent path; absent, fall back to the single `agent:`
  // block so existing single-bot configs keep working unchanged.
  const rawAgents: Array<Record<string, any>> = Array.isArray(raw.agents) && raw.agents.length
    ? raw.agents
    : [{ username: raw.agent?.username ?? 'Steve_AI', brain: defaultBrain }];

  const agents: AgentProfile[] = rawAgents.map((a, i) => ({
    username: a.username ?? `Steve_AI${i || ''}`,
    brain: a.brain ?? defaultBrain,
    viewerPort: Number(a.viewerPort ?? viewerPort + i),
  }));

  return {
    server: {
      host: raw.server?.host ?? '127.0.0.1',
      port: Number(raw.server?.port ?? 25565),
      auth,
      version,
    },
    agent: { username: agents[0].username, brain: agents[0].brain },
    agents,
    conversation: {
      maxMessages: Number(raw.conversation?.maxMessages ?? 16),
      keepRecent: Number(raw.conversation?.keepRecent ?? 6),
    },
    viewer: {
      port: viewerPort,
    },
  };
}
