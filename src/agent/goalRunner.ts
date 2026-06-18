import type { Bot } from 'mineflayer';
import { LLMManager } from '../llm/LLMManager';
import type { LLMProvider } from '../llm/types';
import type { Perception } from '../perception/Perception';
import type { ReflexLayer } from '../reflex/ReflexLayer';
import { SkillRegistry } from '../skills/registry';
import { buildSystemPrompt, buildJsonSystemPrompt, parseJsonPlan, type PlanStep } from '../llm/promptBuilder';
import { ConversationMemory, type ConversationMemoryOptions } from './ConversationMemory';
import { logger } from '../util/logger';

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

  private async runTask(bot: Bot, task: Task): Promise<void> {
    let provider: LLMProvider;
    try {
      provider = this.llm.forRole('planner');
    } catch (err) {
      bot.chat(`LLM not configured: ${errMsg(err)}`);
      return;
    }

    const observation = this.perception.observe();
    const tools = this.skills.toolDefs();
    const mode = this.llm.toolMode('planner');
    const temperature = this.llm.temperature('planner');
    const summary = this.memory.summaryText();

    const finalUser = {
      role: 'user' as const,
      content: `Observation:\n${observation}\n\nPlayer "${task.requestedBy}" says: ${task.message}`,
    };
    const messages = [...this.memory.recent(), finalUser];

    const res = await provider.chat({
      system: withSummary(
        mode === 'json' ? buildJsonSystemPrompt(bot.username, tools) : buildSystemPrompt(bot.username),
        summary,
      ),
      messages,
      tools: mode === 'json' ? [] : tools,
      temperature,
    });

    const plan: PlanStep[] =
      mode === 'json' ? parseJsonPlan(res.text) : res.toolCalls.map((c) => ({ name: c.name, args: c.args }));

    const ctx = { requestedBy: task.requestedBy, reflex: this.reflex, shouldStop: (): boolean => this.cancel };
    let assistantRecord = '';

    if (plan.length === 0) {
      const say = res.text.trim() ? res.text.trim().slice(0, 256) : "I'm not sure how to help with that yet.";
      bot.chat(say);
      assistantRecord = say;
    } else {
      if (plan.length > 1) logger.info(`Executing ${plan.length}-step plan for "${task.message}".`);
      // sayInChat/reportStatus already speak for themselves; everything else (collectBlock,
      // tossItem, attackNearestMob, ...) only returns a result string that used to go
      // straight into memory and nowhere else — the bot would work in total silence. Collect
      // those results and speak them as a wrap-up unless the plan already spoke on its own.
      const resultsForChat: string[] = [];
      const willSpeak = plan.some((p) => p.name === 'sayInChat');
      for (let i = 0; i < plan.length; i++) {
        if (this.cancel) {
          assistantRecord += '(cancelled) ';
          resultsForChat.push('(cancelled)');
          break;
        }
        const step = plan[i];
        if (this.current) this.current.step = `step ${i + 1}/${plan.length}: ${step.name}`;
        const result = await this.skills.execute(bot, step.name, step.args, ctx);
        assistantRecord += `${describeAction(step.name, step.args, result)} `;
        if (step.name !== 'sayInChat' && step.name !== 'reportStatus') resultsForChat.push(result);
      }
      if (!willSpeak && resultsForChat.length) {
        bot.chat(resultsForChat.join(' ').slice(0, 300));
      }
    }

    this.memory.addUser(task.requestedBy, task.message);
    this.memory.addAssistant(assistantRecord.trim() || '(no action)');
    await this.memory.maybeCompact(this.summarizer());
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
