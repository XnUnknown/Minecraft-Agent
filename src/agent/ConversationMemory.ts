import type { ChatMessage, LLMProvider } from '../llm/types';
import { logger } from '../util/logger';

export interface ConversationMemoryOptions {
  /** When stored messages exceed this, compact the oldest into a running summary. */
  maxMessages?: number;
  /** How many recent messages to keep after compaction. */
  keepRecent?: number;
}

/**
 * Rolling chat memory shared across players. Recent turns are fed verbatim into the
 * prompt; once history grows past `maxMessages`, the oldest turns are compressed into a
 * running natural-language summary via the LLM (context compaction), keeping prompts small
 * while preserving long-term context ("remember what we talked about").
 */
export class ConversationMemory {
  private history: ChatMessage[] = [];
  private summary = '';
  private readonly maxMessages: number;
  private readonly keepRecent: number;

  constructor(opts: ConversationMemoryOptions = {}) {
    this.maxMessages = Math.max(4, opts.maxMessages ?? 16);
    this.keepRecent = Math.max(2, Math.min(opts.keepRecent ?? 6, this.maxMessages - 2));
  }

  addUser(name: string, text: string): void {
    this.history.push({ role: 'user', content: `${name}: ${text}` });
  }

  addAssistant(text: string): void {
    this.history.push({ role: 'assistant', content: text });
  }

  /** Recent turns to include in the prompt (a copy). */
  recent(): ChatMessage[] {
    return [...this.history];
  }

  /** Running summary of older turns (may be empty). */
  summaryText(): string {
    return this.summary;
  }

  /** If over budget, fold the oldest turns into the running summary using the LLM. */
  async maybeCompact(summarizer: LLMProvider): Promise<void> {
    if (this.history.length <= this.maxMessages) return;

    const cutoff = this.history.length - this.keepRecent;
    const toSummarize = this.history.slice(0, cutoff);
    const keep = this.history.slice(cutoff);

    const transcript = toSummarize.map((m) => `${m.role}: ${m.content}`).join('\n');
    const prompt = [
      this.summary ? `Existing summary:\n${this.summary}\n` : '',
      `Update the running summary of this Minecraft conversation. Capture durable facts,`,
      `player preferences, named locations, and ongoing tasks. Keep it under 500 words.`,
      `Output ONLY the summary text, no preamble.`,
      ``,
      `New history to fold in:`,
      transcript,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await summarizer.chat({
        system: 'You compress conversation history into a concise, factual running summary.',
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        temperature: 0.2,
        maxTokens: 256,
      });
      const next = res.text.trim();
      if (next) {
        this.summary = next;
        this.history = keep;
        logger.info(`Conversation compacted: folded ${toSummarize.length} msgs, kept ${keep.length}.`);
        return;
      }
    } catch (err) {
      logger.warn(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Fallback: hard-trim so history can't grow unbounded even if summarization failed.
    this.history = keep;
  }
}
