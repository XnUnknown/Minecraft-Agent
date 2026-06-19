import type { Bot } from 'mineflayer';
import { LLMManager } from '../llm/LLMManager';
import type { LLMProvider } from '../llm/types';
import type { Perception } from '../perception/Perception';
import type { ReflexLayer } from '../reflex/ReflexLayer';
import { SkillRegistry } from '../skills/registry';
import {
  buildSystemPrompt,
  buildJsonSystemPrompt,
  parseJsonPlan,
  describeTranscript,
  type PlanStep,
  type TranscriptEntry,
} from '../llm/promptBuilder';
import { ConversationMemory, type ConversationMemoryOptions } from './ConversationMemory';
import { contextBlock as craftingContextBlock } from '../knowledge/CraftingExperience';
import { sendChat } from '../util/chat';
import { logger } from '../util/logger';

/** Batches between an LLM call and execution; capped to bound replan cost on repeated failure. */
const MAX_BATCHES = 4;

interface Task {
  requestedBy: string;
  message: string;
}

/**
 * Agentic loop: chat messages become tasks on a queue that a background worker drains one
 * at a time, planning each via the LLM and executing the steps. The handler never blocks —
 * while a task runs you can still ask for status, cancel, or queue more work. A request
 * marked "now" pre-empts the current task; everything else runs in order. The reflex layer
 * keeps the bot alive between/within steps at no LLM cost.
 */
export class GoalRunner {
  private llm = new LLMManager();
  private skills = new SkillRegistry();
  private memory: ConversationMemory;

  private queue: Task[] = [];
  private current?: { task: Task; step: string };
  private worker?: Promise<void>;
  private cancel = false;
  private bot?: Bot;

  constructor(
    private readonly perception: Perception,
    private readonly reflex: ReflexLayer,
    memoryOpts?: ConversationMemoryOptions,
  ) {
    this.memory = new ConversationMemory(memoryOpts);
    logger.info(`Active ${this.llm.describe('planner')}`);
  }

  /** Entry point for every non-manual chat line. Routes fast intents, else queues a task. */
  async handle(bot: Bot, username: string, message: string): Promise<void> {
    this.bot = bot;
    const intent = classifyIntent(message);

    if (intent === 'stop') {
      this.stopAll();
      bot.chat('Stopping and clearing my task list.');
      return;
    }
    if (intent === 'status') {
      bot.chat(this.describeActivity(bot));
      return;
    }

    // Asking for the same thing again while it's already running/queued isn't a new task —
    // it's almost always "are you still on this?". Answer with live status instead of
    // silently re-running (or stacking a duplicate behind) the same job.
    if (intent === 'task') {
      const norm = normalize(message);
      if (this.current && normalize(this.current.task.message) === norm) {
        bot.chat(this.describeActivity(bot));
        return;
      }
      if (this.queue.some((t) => normalize(t.message) === norm)) {
        bot.chat(`That's already queued up — ${this.describeActivity(bot)}`);
        return;
      }
    }

    const task: Task = { requestedBy: username, message };
    if (intent === 'now') {
      // Pre-empt: drop the current task and jump the queue.
      this.cancelCurrent();
      this.queue.unshift(task);
    } else {
      this.queue.push(task);
      // Only speak up when the task can't start immediately, so the player knows it's queued
      // (not ignored). When idle we stay quiet and let the LLM reply once it has thought.
      if (this.current) bot.chat(`Queued — I'll get to that after the current job.`);
    }
    this.ensureWorker(bot);
  }

  /** A short, live description of what the bot is doing — answerable mid-task, no LLM. */
  describeActivity(bot: Bot): string {
    const p = bot.entity?.position;
    const where = p ? `at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})` : 'somewhere';
    const vitals = `HP ${Math.round(bot.health ?? 0)}/20, food ${Math.round(bot.food ?? 0)}/20`;
    if (this.current) {
      const queued = this.queue.length ? `, ${this.queue.length} more queued` : '';
      return `Working on "${this.current.task.message}" — ${this.current.step}${queued}. ${where}, ${vitals}.`;
    }
    if (this.queue.length) return `About to start ${this.queue.length} queued task(s). ${where}, ${vitals}.`;
    return `Idle ${where}, ${vitals}. Give me a task whenever.`;
  }

  /** Cancel everything: current task, queue, movement, combat, gathering. */
  stopAll(): void {
    this.queue = [];
    this.cancelCurrent();
  }

  private cancelCurrent(): void {
    this.cancel = true;
    const bot = this.bot;
    if (!bot) return;
    try {
      bot.pathfinder.setGoal(null);
    } catch {
      /* ignore */
    }
    try {
      (bot as unknown as { pvp?: { stop(): void } }).pvp?.stop();
    } catch {
      /* ignore */
    }
    try {
      (bot as unknown as { collectBlock?: { cancelTask?(): void } }).collectBlock?.cancelTask?.();
    } catch {
      /* ignore */
    }
    this.reflex.setSuppressDefense(false);
    this.reflex.setOnReleaseNav(undefined);
  }

  private ensureWorker(bot: Bot): void {
    if (this.worker) return;
    this.worker = this.runLoop(bot).finally(() => {
      this.worker = undefined;
    });
  }

  /** Background loop: drain the queue one task at a time. */
  private async runLoop(bot: Bot): Promise<void> {
    while (this.queue.length) {
      const task = this.queue.shift()!;
      this.current = { task, step: 'planning' };
      this.cancel = false;
      try {
        await this.runTask(bot, task);
      } catch (err) {
        logger.error(`task failed: ${errMsg(err)}`);
        bot.chat(`Ran into a problem: ${errMsg(err)}`);
      }
      this.current = undefined;
    }
  }

  /**
   * Runs one task as a sequence of LLM-planned batches. Each batch executes in order and
   * stops at the first failed step (later steps usually depended on it); a failure feeds the
   * whole transcript back to the LLM so it can issue a corrective plan or give up with an
   * explanation, instead of blindly continuing a plan whose premise just broke. Implements
   * ARCHITECTURE_PLAN.md §5.3b/§5.4 ("batch executor" + replan-on-failure).
   */
  private async runTask(bot: Bot, task: Task): Promise<void> {
    let provider: LLMProvider;
    try {
      provider = this.llm.forRole('planner');
    } catch (err) {
      bot.chat(`LLM not configured: ${errMsg(err)}`);
      return;
    }

    const tools = this.skills.toolDefs();
    const mode = this.llm.toolMode('planner');
    const temperature = this.llm.temperature('planner');
    const maxTokens = this.llm.maxTokens('planner') ?? 2048;
    const system = withContext(
      mode === 'json' ? buildJsonSystemPrompt(bot.username, tools) : buildSystemPrompt(bot.username),
      this.memory.summaryText(),
      craftingContextBlock(),
    );

    const observation = this.perception.observe();
    const baseUser = {
      role: 'user' as const,
      content: `Observation:\n${observation}\n\nPlayer "${task.requestedBy}" says: ${task.message}`,
    };
    let messages = [...this.memory.recent(), baseUser];

    const ctx = { requestedBy: task.requestedBy, reflex: this.reflex, shouldStop: (): boolean => this.cancel };
    const transcript: TranscriptEntry[] = [];
    let assistantRecord = '';
    let finalMessage: string | null = null;
    let willSpeak = false;
    let cancelled = false;

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const res = await provider.chat({
        system,
        messages,
        tools: mode === 'json' ? [] : tools,
        temperature,
        maxTokens,
      });
      const plan: PlanStep[] =
        mode === 'json' ? parseJsonPlan(res.text) : res.toolCalls.map((c) => ({ name: c.name, args: c.args }));

      if (plan.length === 0) {
        finalMessage = res.text.trim();
        break;
      }
      if (plan.length > 1 || batch > 0) {
        logger.info(`Executing ${plan.length}-step plan (batch ${batch + 1}) for "${task.message}".`);
      }

      let batchFailed = false;
      for (let i = 0; i < plan.length; i++) {
        if (this.cancel) {
          cancelled = true;
          break;
        }
        const step = plan[i];
        if (step.name === 'sayInChat') willSpeak = true;
        if (this.current) this.current.step = `batch ${batch + 1} step ${i + 1}/${plan.length}: ${step.name}`;
        const result = await this.skills.execute(bot, step.name, step.args, ctx);
        transcript.push({ tool: step.name, args: step.args, ok: result.ok, message: result.message });
        assistantRecord += `${describeAction(step.name, step.args, result.message)} `;
        if (!result.ok) {
          batchFailed = true;
          break;
        }
      }

      if (cancelled || !batchFailed) break; // done, or no point continuing this run

      // Replan: recap the whole transcript so far and let the LLM decide what to do next.
      messages = [
        ...this.memory.recent(),
        baseUser,
        { role: 'user' as const, content: `Tool results so far:\n${describeTranscript(transcript)}` },
      ];
    }

    if (cancelled) {
      assistantRecord += '(cancelled) ';
    } else {
      let reply = finalMessage?.trim() ?? '';
      if (!reply && !willSpeak) {
        reply = transcript.length
          ? await this.composeFinalReply(task, transcript)
          : "I'm not sure how to help with that yet.";
      }
      if (reply) {
        sendChat(bot, reply);
        assistantRecord += reply;
      }
    }

    this.memory.addUser(task.requestedBy, task.message);
    this.memory.addAssistant(assistantRecord.trim() || '(no action)');
    await this.memory.maybeCompact(this.summarizer());
  }

  /**
   * Composes one natural-language wrap-up from a finished transcript via the cheap "fast"
   * role, instead of mechanically joining raw tool-result strings — falls back to that raw
   * join if the call errors (e.g. "fast" role unavailable).
   */
  private async composeFinalReply(task: Task, transcript: TranscriptEntry[]): Promise<string> {
    const raw = transcript.map((t) => t.message).join(' ').slice(0, 300);
    try {
      const res = await this.summarizer().chat({
        system:
          'You are a Minecraft bot reporting back to a player after finishing actions. Reply in 1-2 ' +
          'short, friendly sentences summarizing the outcome — mention any failures honestly. No preamble.',
        messages: [
          {
            role: 'user',
            content:
              `Player "${task.requestedBy}" asked: "${task.message}"\n\n` +
              `Actions taken:\n${describeTranscript(transcript)}\n\nCompose the reply.`,
          },
        ],
        tools: [],
        temperature: 0.3,
        maxTokens: 150,
      });
      return res.text.trim() || raw;
    } catch {
      return raw;
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

/** Lightweight, no-LLM intent routing for the few cases that must be instant. */
function classifyIntent(message: string): 'stop' | 'status' | 'now' | 'task' {
  const m = message.trim().toLowerCase();
  if (/^(stop|halt|cancel|abort|wait stop|stop it|drop it|nevermind|never mind)\b/.test(m)) return 'stop';
  if (/\b(stop (what|doing|everything)|drop everything|stop and)\b/.test(m)) return 'stop';
  if (/\b(status|sitrep|report back|what('?s| is| are you| ?cha)?\s*(your status|you doing|going on)|how('?s| is) it going)\b/.test(m))
    return 'status';
  if (/\b(right now|do it now|stop and|immediately|drop everything|urgent)\b/.test(m)) return 'now';
  return 'task';
}

/** Loose equality for "is this the same request as last time" checks. */
function normalize(message: string): string {
  return message.trim().toLowerCase().replace(/[!?.]+$/g, '').replace(/\s+/g, ' ');
}

function withContext(system: string, summary: string, craftingNotes: string): string {
  const parts = [system];
  if (craftingNotes) parts.push(`Known crafting recipes (learned from past successes):\n${craftingNotes}`);
  if (summary) parts.push(`Conversation summary so far:\n${summary}`);
  return parts.join('\n\n');
}

function describeAction(name: string, args: Record<string, unknown>, result: string): string {
  if (name === 'sayInChat') return String(args.message ?? result);
  return `(${name} -> ${result})`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
