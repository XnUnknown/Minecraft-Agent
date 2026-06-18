import OpenAI from 'openai';
import type { ChatRequest, ChatResponse, LLMProvider, ToolDef } from '../types';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
}

/** OpenAI (and OpenAI-compatible) provider using native function calling. */
export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  private client: OpenAI;
  private model: string;

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model;
    this.id = `openai:${opts.model}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params: Record<string, unknown> = {
      model: this.model,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 1024,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    if (req.tools.length > 0) {
      params.tools = req.tools.map(toOpenAITool);
      params.tool_choice = 'auto';
    }

    const res = await this.client.chat.completions.create(params as any);
    const msg = (res as any).choices?.[0]?.message;
    const toolCalls = ((msg?.tool_calls ?? []) as any[])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({ name: tc.function.name, args: safeParse(tc.function.arguments) }));
    return { text: msg?.content ?? '', toolCalls, raw: res };
  }
}

function toOpenAITool(t: ToolDef) {
  return { type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return (s as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
