/**
 * Provider-agnostic LLM contract. Every provider (OpenAI, Claude, Ollama) implements
 * `LLMProvider`; tool definitions are normalized here and translated per-provider.
 */

/** A single tool parameter (JSON Schema subset). */
export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  enum?: (string | number)[];
}

/** JSON Schema (object) describing a tool's arguments. */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Normalized tool definition, shared across all providers. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/** A structured action the model wants to take. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  /** Tools to expose via native tool-calling. Empty => no native tools (JSON mode). */
  tools: ToolDef[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  /** Free-text from the model (explanation / conversational reply / JSON payload). */
  text: string;
  /** Native structured tool calls, in order. Empty for JSON-mode models. */
  toolCalls: ToolCall[];
  /** Raw provider response, for debugging. */
  raw?: unknown;
}

export interface LLMProvider {
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed?(texts: string[]): Promise<number[][]>;
}
