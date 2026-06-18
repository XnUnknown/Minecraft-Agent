import type { Bot } from 'mineflayer';
import { LLMManager } from '../llm/LLMManager';
import type { LLMProvider } from '../llm/types';
import { SkillRegistry } from '../skills/registry';
import { buildObservation } from '../perception/snapshot';
import { buildSystemPrompt, buildJsonSystemPrompt, parseJsonToolCall } from '../llm/promptBuilder';
import { ConversationMemory, type ConversationMemoryOptions } from './ConversationMemory';
import { logger } from '../util/logger';

/**
 * Stage 3 loop (+ conversation memory): chat message -> observation + history + prompt
 * -> LLM -> execute tool call(s). Single-shot (batching/replan is Stage 6). Supports
 * native tool calling and JSON-mode models (e.g. Gemma) transparently, and remembers the
 * conversation with automatic context compaction.
 */
export class GoalRunner {
  private llm = new LLMManager();
  private skills = new SkillRegistry();
  private memory: ConversationMemory;
  private busy = false;

  constructor(memoryOpts?: ConversationMemoryOptions) {
    this.memory = new ConversationMemory(memoryOpts);
    logger.info(`Active ${this.llm.describe('planner')}`);
  }

  async handle(bot: Bot, username: string, message: string): Promise<void> {
    if (this.busy) {
      bot.chat('One moment — still working on the last request.');
      return;
    }
    this.busy = true;
    try {
      let provider: LLMProvider;
      try {
        provider = this.llm.forRole('planner');
      } catch (err) {
        bot.chat(`LLM not configured: ${errMsg(err)}`);
        return;
      }

      const observation = buildObservation(bot);
      const tools = this.skills.toolDefs();
      const mode = this.llm.toolMode('planner');
      const temperature = this.llm.temperature('planner');
      const summary = this.memory.summaryText();

      const finalUser = {
        role: 'user' as const,
        content: `Observation:\n${observation}\n\nPlayer "${username}" says: ${message}`,
      };
      const messages = [...this.memory.recent(), finalUser];

      let assistantRecord = '';
      if (mode === 'json') {
        const res = await provider.chat({
          system: withSummary(buildJsonSystemPrompt(bot.username, tools), summary),
          messages,
          tools: [], // JSON mode: no native tools
          temperature,
        });
        const parsed = parseJsonToolCall(res.text);
        if (parsed) {
          const result = await this.skills.execute(bot, parsed.name, parsed.args, { requestedBy: username });
          assistantRecord = describeAction(parsed.name, parsed.args, result);
        } else if (res.text.trim()) {
          const say = res.text.trim().slice(0, 256);
          bot.chat(say);
          assistantRecord = say;
        } else {
          bot.chat("I'm not sure how to help with that yet.");
          assistantRecord = '(no action)';
        }
      } else {
        const res = await provider.chat({
          system: withSummary(buildSystemPrompt(bot.username), summary),
          messages,
          tools,
          temperature,
        });
        if (res.toolCalls.length === 0 && res.text.trim()) {
          const say = res.text.trim().slice(0, 256);
          bot.chat(say);
          assistantRecord = say;
        }
        for (const call of res.toolCalls) {
          const result = await this.skills.execute(bot, call.name, call.args, { requestedBy: username });
          assistantRecord += `${describeAction(call.name, call.args, result)} `;
        }
        if (res.toolCalls.length === 0 && !res.text.trim()) {
          bot.chat("I'm not sure how to help with that yet.");
          assistantRecord = '(no action)';
        }
      }

      // Record the turn, then compact if the history has grown too long.
      this.memory.addUser(username, message);
      this.memory.addAssistant(assistantRecord.trim() || '(no action)');
      await this.memory.maybeCompact(this.summarizer());
    } catch (err) {
      logger.error(`goal handling failed: ${errMsg(err)}`);
      bot.chat(`Something went wrong: ${errMsg(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Cheap model for summarization; falls back to the planner if "fast" isn't set. */
  private summarizer(): LLMProvider {
    try {
      return this.llm.forRole('fast');
    } catch {
      return this.llm.forRole('planner');
    }
  }
}

function withSummary(system: string, summary: string): string {
  return summary ? `${system}\n\nConversation summary so far:\n${summary}` : system;
}

function describeAction(name: string, args: Record<string, unknown>, result: string): string {
  if (name === 'sayInChat') return String(args.message ?? result);
  return `(${name} -> ${result})`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
