import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResponse, LLMProvider, ToolDef } from '../types';

export interface ClaudeProviderOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
}

/** Anthropic Claude provider using native tool use. */
export class ClaudeProvider implements LLMProvider {
  readonly id: string;
  private client: Anthropic;
  private model: string;

  constructor(opts: ClaudeProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model;
    this.id = `claude:${opts.model}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.4,
      system: req.system,
      messages: req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    };
    if (req.tools.length > 0) {
      params.tools = req.tools.map(toClaudeTool);
    }

    const res = await this.client.messages.create(params as any);
    let text = '';
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    for (const block of (res as any).content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return { text, toolCalls, raw: res };
  }
}

function toClaudeTool(t: ToolDef) {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}
