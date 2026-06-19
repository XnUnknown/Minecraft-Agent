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
  extractJsonProse,
  type PlanStep,
  type TranscriptEntry,
} from '../llm/promptBuilder';
import { ConversationMemory, type ConversationMemoryOptions } from './ConversationMemory';
import { contextBlock as craftingContextBlock } from '../knowledge/CraftingExperience';
import { contextBlock as agentExperienceContextBlock, recordExperience } from '../knowledge/AgentExperience';
import { sendChat } from '../util/chat';
import { logger } from '../util/logger';

/** Turns between an LLM call and execution; capped to bound cost. Every task now takes at
 *  least 2 (act, then confirm-done), so this needs more headroom than a failure-only retry cap. */
const MAX_BATCHES = 6;

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
    private readonly peerUsernames: string[] = [],
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

  /** True while a task is actively running (not just queued) — used to give peer agents a
   *  direct busy reply instead of silently queuing their request behind this one. */
  isBusy(): boolean {
    return !!this.current;
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
    // Clear immediately so describeActivity/queued-detection reflect "stopped" right away —
    // the in-flight runTask call may take a few more ticks to actually unwind (it polls
    // shouldStop internally), but nothing should look "current" to the rest of the system
    // while that happens, or a message sent right after "stop" wrongly queues behind it.
    this.current = undefined;
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
   * Runs one task as a ReAct-style loop: act, observe the results, decide what's next —
   * repeated until the LLM itself signals it's done (a turn with no tool calls), not just
   * when a batch fails. A batch still stops at its first failed step (later steps usually
   * depended on it), but **every** batch — success or failure — feeds the transcript back
   * for another turn, since "this step succeeded" isn't the same as "the whole task is
   * done" (e.g. checking a recipe succeeding is not the same as having acted on it).
   * Native tool-calling models can narrate AND call tools in the same turn — that text is
   * spoken immediately instead of being discarded. Implements ARCHITECTURE_PLAN.md
   * §5.3b/§5.4 ("batch executor" + replan), generalized from failure-only to every turn.
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
      agentExperienceContextBlock(),
      this.peerUsernames,
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
    let cancelled = false;
    // A small JSON-mode model often doesn't reliably recognize "everything I asked for just
    // succeeded, I'm done" and instead re-emits the identical plan — without this it would
    // repeat the whole job (re-gather, re-deliver, ...) forever, batch after batch.
    let lastPlanSig: string | null = null;
    let lastBatchAllOk = false;

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      logger.info(
        batch === 0
          ? `[loop ${batch + 1}] planner request: "${task.message}"`
          : `[loop ${batch + 1}] planner request: replanning after ${transcript.length} result(s)`,
      );
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
        // JSON mode's "done" turn is often bare JSON with no prose (e.g. `{"plan": []}`) —
        // extract any real prose instead of treating the raw JSON text as a chat message.
        finalMessage = mode === 'json' ? extractJsonProse(res.text) : res.text.trim();
        logger.info(`[loop ${batch + 1}] planner response: done${finalMessage ? ` — "${finalMessage}"` : ''}`);
        break;
      }
      logger.info(`[loop ${batch + 1}] planner response: ${plan.map((p) => p.name).join(', ')}`);

      const planSig = JSON.stringify(plan.map((p) => [p.name, p.args]));
      if (batch > 0 && lastBatchAllOk && planSig === lastPlanSig) {
        logger.info(`[loop ${batch + 1}] same plan as the already-fully-successful last batch — treating as done.`);
        break;
      }
      lastPlanSig = planSig;

      // Native models can say something WHILE calling a tool in the same turn (e.g. "checking
      // the recipe now" + the getRecipe call) — speak that narration right away instead of
      // discarding it. JSON mode's res.text is the structured plan itself, not prose, so this
      // doesn't apply there (narrate-while-acting works there via an explicit sayInChat step).
      if (mode !== 'json') {
        const narration = res.text.trim();
        if (narration) {
          sendChat(bot, narration);
          assistantRecord += `${narration} `;
        }
      }

      lastBatchAllOk = true;
      for (let i = 0; i < plan.length; i++) {
        if (this.cancel) {
          cancelled = true;
          break;
        }
        const step = plan[i];
        if (this.current) this.current.step = `batch ${batch + 1} step ${i + 1}/${plan.length}: ${step.name}`;
        const result = await this.skills.execute(bot, step.name, step.args, ctx);
        transcript.push({ tool: step.name, args: step.args, ok: result.ok, message: result.message });
        assistantRecord += `${describeAction(step.name, step.args, result.message)} `;
        // A long-running step (gathering, crafting) may have been told to stop mid-flight and
        // only now returned — check again here, not just before the step started, so we don't
        // loop back and ask the LLM for yet another batch after the user said stop.
        if (this.cancel) {
          cancelled = true;
          break;
        }
        // Stop the rest of THIS batch on failure (later steps usually depended on it), but
        // still loop back to the LLM below regardless of success or failure.
        if (!result.ok) {
          lastBatchAllOk = false;
          break;
        }
      }

      if (cancelled) break;

      // A batch that was ENTIRELY talk (no real action) and succeeded essentially never
      // needs another follow-up turn — without this, a small model asked "anything else?"
      // after just answering "hello" will keep inventing slightly different ways to say
      // hello again, batch after batch, since rephrased text doesn't match the exact-repeat
      // check below. Exempt batch 0: that's also the shape of "I'll check the recipe now"
      // (talk-only) said WITHOUT the paired tool call the prompt asks for — continuing once
      // gives the model a chance to actually call it next turn instead of just talking forever.
      if (batch > 0 && lastBatchAllOk && plan.every((p) => p.name === 'sayInChat')) break;

      // Always loop back with the transcript so far — even a fully successful batch may not
      // be the whole task. The LLM decides it's actually done by returning no more tool calls.
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
      // If every action taken was just talking, sayInChat already said what needed saying —
      // a composed wrap-up would just awkwardly repeat the greeting.
      const onlyTalked = transcript.length > 0 && transcript.every((t) => t.tool === 'sayInChat');
      if (!reply && !onlyTalked) {
        reply = transcript.length
          ? await this.composeFinalReply(task, transcript)
          : "I'm not sure how to help with that yet.";
      }
      if (reply) {
        sendChat(bot, reply);
        assistantRecord += reply;
      }

      // The main goal completed cleanly (last batch succeeded, nothing cancelled) AND
      // generated code/a saved skill actually did some of the work — worth remembering the
      // approach for next time, the same way CraftingExperience does for recipes.
      const generatedSteps = transcript.filter(
        (t) => t.ok && (t.tool === 'runCode' || this.skills.isDynamic(t.tool)),
      );
      if (lastBatchAllOk && generatedSteps.length) {
        recordExperience(
          task.message,
          generatedSteps.map((t) => `${t.tool}(${JSON.stringify(t.args)})`).join('; '),
          reply || 'Completed successfully.',
        );
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

function withContext(
  system: string,
  summary: string,
  craftingNotes: string,
  agentExperience: string,
  peerUsernames: string[],
): string {
  const parts = [system];
  if (peerUsernames.length) {
    parts.push(
      `Other agents online alongside you: ${peerUsernames.join(', ')}. Use messageAgent to ask ` +
        `one of them for help (e.g. a material you don't have) — they'll do it and deliver, or ` +
        `reply that they're busy.`,
    );
  }
  if (craftingNotes) parts.push(`Known crafting recipes (learned from past successes):\n${craftingNotes}`);
  if (agentExperience) parts.push(`Past completed tasks (learned approaches that already worked):\n${agentExperience}`);
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
