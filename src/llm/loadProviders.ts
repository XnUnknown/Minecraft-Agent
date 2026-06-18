import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type ProviderKind = 'openai' | 'claude' | 'ollama';
export type OllamaMode = 'local' | 'cloud';
export type ToolCalling = 'native' | 'json';

export interface RoleRouting {
  provider: ProviderKind;
  model: string;
  mode?: OllamaMode; // ollama only
  toolCalling?: ToolCalling; // default 'native'
  temperature?: number;
}

export interface ProvidersConfig {
  roles: {
    planner: RoleRouting;
    fast?: RoleRouting;
    embeddings?: RoleRouting;
  };
  providers: {
    openai?: { apiKeyEnv: string; baseUrl?: string };
    claude?: { apiKeyEnv: string; baseUrl?: string };
    ollama?: {
      local?: { baseUrl: string };
      cloud?: { baseUrl: string; apiKeyEnv?: string };
    };
  };
}

export function loadProvidersConfig(path = 'config/providers.yaml'): ProvidersConfig {
  return parse(readFileSync(path, 'utf8')) as ProvidersConfig;
}
