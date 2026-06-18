import 'dotenv/config';
import type { LLMProvider } from './types';
import {
  loadProvidersConfig,
  type ProvidersConfig,
  type RoleRouting,
  type ToolCalling,
} from './loadProviders';
import { OpenAIProvider } from './providers/openai';
import { ClaudeProvider } from './providers/claude';
import { OllamaProvider } from './providers/ollama';
import { logger } from '../util/logger';

export type Role = 'planner' | 'fast' | 'embeddings';

/**
 * Resolves the configured provider for each role from providers.yaml, lazily building
 * provider instances (so a missing API key only errors when that role is actually used).
 */
export class LLMManager {
  private config: ProvidersConfig;
  private cache = new Map<Role, LLMProvider>();

  constructor(config?: ProvidersConfig) {
    this.config = config ?? loadProvidersConfig();
  }

  forRole(role: Role): LLMProvider {
    const cached = this.cache.get(role);
    if (cached) return cached;

    const routing = this.config.roles[role];
    if (!routing) throw new Error(`No LLM routing configured for role "${role}"`);

    const provider = this.build(routing);
    this.cache.set(role, provider);
    logger.info(`LLM role "${role}" -> ${provider.id}`);
    return provider;
  }

  toolMode(role: Role): ToolCalling {
    return this.config.roles[role]?.toolCalling ?? 'native';
  }

  temperature(role: Role): number | undefined {
    return this.config.roles[role]?.temperature;
  }

  describe(role: Role): string {
    const r = this.config.roles[role];
    if (!r) return `${role}: <unset>`;
    return `${role}: ${r.provider}${r.mode ? '/' + r.mode : ''} (${r.model}, ${r.toolCalling ?? 'native'})`;
  }

  private build(routing: RoleRouting): LLMProvider {
    const p = this.config.providers;
    switch (routing.provider) {
      case 'openai': {
        if (!p.openai) throw new Error('providers.openai is not configured');
        return new OpenAIProvider({
          apiKey: requireEnv(p.openai.apiKeyEnv),
          baseURL: p.openai.baseUrl,
          model: routing.model,
        });
      }
      case 'claude': {
        if (!p.claude) throw new Error('providers.claude is not configured');
        return new ClaudeProvider({
          apiKey: requireEnv(p.claude.apiKeyEnv),
          baseURL: p.claude.baseUrl,
          model: routing.model,
        });
      }
      case 'ollama': {
        const mode = routing.mode ?? 'local';
        const oc = p.ollama?.[mode];
        if (!oc) throw new Error(`providers.ollama.${mode} is not configured`);
        const apiKey =
          mode === 'cloud' && p.ollama?.cloud?.apiKeyEnv
            ? requireEnv(p.ollama.cloud.apiKeyEnv)
            : undefined;
        return new OllamaProvider({ baseUrl: oc.baseUrl, model: routing.model, apiKey });
      }
      default:
        throw new Error(`Unknown provider "${(routing as RoleRouting).provider}"`);
    }
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Environment variable ${name} is not set`);
  return v;
}
