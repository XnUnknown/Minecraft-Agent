import type { ChatRequest, ChatResponse, LLMProvider, ToolDef } from '../types';

export interface OllamaProviderOptions {
  /** e.g. http://localhost:11434 (local) or https://ollama.com (cloud) */
  baseUrl: string;
  model: string;
  /** Bearer token for Ollama Cloud; omit for local. */
  apiKey?: string;
}

/** Ollama provider (local or cloud) via the native /api/chat endpoint. */
export class OllamaProvider implements LLMProvider {
  readonly id: string;
  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(opts: OllamaProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.id = `ollama:${opts.model}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      model: this.model,
      stream: false,
      options: { temperature: req.temperature ?? 0.4 },
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map(toOllamaTool);
    }

    const resp = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Ollama ${resp.status} ${resp.statusText}: ${errText.slice(0, 300)}`);
    }

    const data = (await resp.json()) as any;
    const msg = data.message ?? {};
    const toolCalls = ((msg.tool_calls ?? []) as any[])
      .map((tc) => ({
        name: tc.function?.name,
        args:
          typeof tc.function?.arguments === 'string'
            ? safeParse(tc.function.arguments)
            : (tc.function?.arguments ?? {}),
      }))
      .filter((c) => Boolean(c.name));
    return { text: msg.content ?? '', toolCalls, raw: data };
  }
}

function toOllamaTool(t: ToolDef) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
