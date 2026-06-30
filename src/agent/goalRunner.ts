import type { Bot } from 'mineflayer';
import { LLMManager } from '../llm/LLMManager';
import type { LLMProvider, ChatMessage, ToolDef } from '../llm/types';
import type { Perception } from '../perception/Perception';
import type { ReflexLayer } from '../reflex/ReflexLayer';
import { SkillRegistry, type SkillRegistryOptions } from '../skills/registry';
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
import { BuildState } from '../building/BuildSession';
import { contextBlock as craftingContextBlock } from '../knowledge/CraftingExperience';
import { contextBlock as agentExperienceContextBlock, recordExperience } from '../knowledge/AgentExperience';
import { sendChat } from '../util/chat';
import { logger } from '../util/logger';
import { dumpContext } from '../util/contextDump';

/** Batches (LLM call + execution) allotted to ONE player line before the session idles. A line
 *  gets a fresh budget each time it (or a new line) is folded in, so multi-step jobs have room
 *  while a stuck one still gives up instead of looping forever. */
const MAX_BATCHES = 6;

interface Task {
  requestedBy: string;
  message: string;
}

/**
 * Agentic loop with a SINGLE live session — no task queue. Every chat line is dropped into a
 * `pending` inbox; the running session folds new lines into the SAME LLM context (the current
 * plan + the results so far) at its next turn, so the model adjusts with full context instead
 * of re-planning the whole job blind. `stop` cancels everything; an urgent ("now") line also
 * cuts the current long-running step short so it's acted on at once. The reflex layer keeps the
 * bot alive between/within steps at no LLM cost.
 */
export class GoalRunner {
  private llm = new LLMManager();
  private skills: SkillRegistry;
  private memory: ConversationMemory;
  /** Build-mode flag + the live structural model, threaded into every skill's context. */
  private building = new BuildState();

  /** New player lines not yet shown to the LLM — folded into the live session at its next turn. */
  private pending: Task[] = [];
  /** The line currently being worked, plus a human-readable step, for instant status replies. */
  private current?: { task: Task; step: string };
  private worker?: Promise<void>;
  /** Hard stop: unwind the whole session and clear the inbox. */
  private cancel = false;
  /** Soft cut: abandon the current long-running step and re-plan with whatever just arrived. */
  private abortStep = false;
  private bot?: Bot;

  constructor(
    private readonly perception: Perception,
    private readonly reflex: ReflexLayer,
    private readonly peerUsernames: string[] = [],
    memoryOpts?: ConversationMemoryOptions,
    skillsOpts?: SkillRegistryOptions,
  ) {
    this.skills = new SkillRegistry(skillsOpts);
    this.memory = new ConversationMemory(memoryOpts);
    logger.info(`Active ${this.llm.describe('planner')}`);
  }

  /** Entry point for every non-manual chat line. Routes instant intents, else folds the line
   *  into the live session. */
  async handle(bot: Bot, username: string, message: string): Promise<void> {
    this.bot = bot;
    const intent = classifyIntent(message);

    if (intent === 'stop') {
      this.stopAll();
      bot.chat('Stopping and dropping what I was doing.');
      return;
    }
    if (intent === 'status') {
      bot.chat(this.describeActivity(bot));
      return;
    }

    // "are you still on it?" — same text as the live line, or one already waiting to be folded
    // in: answer with status instead of stacking a duplicate.
    const norm = normalize(message);
    if (this.current && normalize(this.current.task.message) === norm) {
      bot.chat(this.describeActivity(bot));
      return;
    }
    if (this.pending.some((t) => normalize(t.message) === norm)) {
      bot.chat(this.describeActivity(bot));
      return;
    }

    this.pending.push({ requestedBy: username, message });
    // Urgent: also cut the current long step short (only meaningful if something IS running) so
    // the new line is acted on now, not just at the next natural batch boundary.
    if (intent === 'now' && this.current) this.abortStep = true;
    this.ensureWorker(bot);
  }

  /** True while a line is actively being worked (not merely waiting in the inbox) — peer agents
   *  use this for a direct busy reply instead of silently piling on. */
  isBusy(): boolean {
    return !!this.current;
  }

  /** Manual build-mode toggle (the `build` / `build off` chat command). The agent can also flip
   *  this itself via the enterBuildMode/exitBuildMode tools. Returns a short status line. */
  setBuildMode(on: boolean, bot?: Bot): string {
    if (on) {
      this.building.enter('', '');
      return 'Building mode ON — building tools and structural tracking are available.';
    }
    const summary = bot ? this.building.session.summary(bot) : this.building.session.summary();
    this.building.exit();
    return `Building mode OFF. ${summary}`;
  }

  /** A short, live description of what the bot is doing — answerable mid-task, no LLM. */
  describeActivity(bot: Bot): string {
    const p = bot.entity?.position;
    const where = p ? `at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})` : 'somewhere';
    const vitals = `HP ${Math.round(bot.health ?? 0)}/20, food ${Math.round(bot.food ?? 0)}/20`;
    if (this.current) {
      const waiting = this.pending.length ? `, ${this.pending.length} new message(s) to fold in` : '';
      // If we're pathing somewhere, lead with that (and how far to go) so "where are you?" mid-trek
      // gets "still on my way, ~640 blocks out" instead of a stale step label.
      const step = describeTravel(bot) ?? this.current.step;
      return `Working on "${this.current.task.message}" — ${step}${waiting}. ${where}, ${vitals}.`;
    }
    if (this.pending.length) return `Picking up your message now. ${where}, ${vitals}.`;
    return `Idle ${where}, ${vitals}. Give me a task whenever.`;
  }

  /** Cancel everything: live session, inbox, movement, combat, gathering. */
  stopAll(): void {
    this.pending = [];
    this.cancel = true;
    this.cancelActiveActions();
  }

  /** Tears down any in-flight bot actions and clears the "current" marker; the running session
   *  notices `cancel`/`abortStep` on its next poll and unwinds. */
  private cancelActiveActions(): void {
    this.current = undefined;
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
    // Fresh start: clear any leftover stop/abort flags from a previous, now-finished session.
    this.cancel = false;
    this.abortStep = false;
    this.worker = this.runSession(bot)
      .catch((err) => logger.error(`session failed: ${errMsg(err)}`))
      .finally(() => {
        this.worker = undefined;
        // A line that arrived in the tiny gap as the session wound down — pick it up.
        if (this.pending.length) this.ensureWorker(bot);
      });
  }

  /**
   * The single live session. Runs a ReAct loop (act, observe results, decide next) but, unlike
   * a per-task runner, it stays alive and FOLDS newly-arrived player lines into the same running
   * context at the top of each turn — the new line is shown alongside the results so far, so the
   * model continues/adjusts the existing plan rather than restarting blind. Each line gets a
   * fresh batch budget; when the model signals done (no tool calls) and nothing's waiting, the
   * session ends.
   */
  private async runSession(bot: Bot): Promise<void> {
    let provider: LLMProvider;
    try {
      provider = this.llm.forRole('planner');
    } catch (err) {
      bot.chat(`LLM not configured: ${errMsg(err)}`);
      this.pending = [];
      return;
    }

    const mode = this.llm.toolMode('planner');
    const temperature = this.llm.temperature('planner');
    const maxTokens = this.llm.maxTokens('planner') ?? 2048;
    const codeOn = this.skills.codeExecution;

    const ctx = {
      requestedBy: '',
      reflex: this.reflex,
      shouldStop: (): boolean => this.cancel || this.abortStep,
      building: this.building,
    };

    // Tools + system prompt are rebuilt every turn (cheap — context files are cached) so a
    // mid-session enterBuildMode/exitBuildMode reveals or hides the building tools and the live
    // structural model immediately, and the volatile context blocks stay fresh.
    const promptFor = (): { system: string; tools: ToolDef[] } => {
      const build = this.building.enabled;
      const t = this.skills.toolDefs(build);
      const base = mode === 'json' ? buildJsonSystemPrompt(bot.username, t, codeOn) : buildSystemPrompt(bot.username, codeOn);
      const sys = withContext(
        base,
        this.memory.summaryText(),
        craftingContextBlock(),
        agentExperienceContextBlock(),
        this.peerUsernames,
        build ? this.building.session.summary(bot) : '',
      );
      return { system: sys, tools: t };
    };

    const transcript: TranscriptEntry[] = [];
    let messages: ChatMessage[] = [];
    let assistantRecord = '';
    let budget = 0;
    let lastPlanSig: string | null = null;
    let lastBatchAllOk = false;

    // Wrap up the line currently being worked: speak a reply (or a composed summary), record it
    // to memory, learn from any generated-code steps, and reset per-line state for the next one.
    const resolveCurrent = async (finalMessage: string): Promise<void> => {
      await this.finishResponse(bot, this.current?.task, finalMessage, transcript, assistantRecord, lastBatchAllOk);
      await this.memory.maybeCompact(this.summarizer());
      assistantRecord = '';
      this.current = undefined;
      transcript.length = 0;
      lastBatchAllOk = false;
      lastPlanSig = null;
      budget = 0;
    };

    while (!this.cancel) {
      // 1) Fold any newly-arrived player lines into the live context.
      if (this.pending.length) {
        const incoming = this.pending.splice(0, this.pending.length);
        const observation = this.perception.observe();
        messages = [...this.memory.recent()];
        for (const t of incoming) {
          ctx.requestedBy = t.requestedBy;
          this.current = { task: t, step: 'planning' };
          this.memory.addUser(t.requestedBy, t.message);
        }
        // Show EVERY newly-arrived line, not just the last — if the player fired off several
        // messages they should all reach the model, in order, not be collapsed to the latest.
        const said = incoming.map((t) => `Player "${t.requestedBy}" says: ${t.message}`).join('\n');
        messages.push({ role: 'user', content: `Observation:\n${observation}\n\n${said}` });
        if (transcript.length) {
          // The crux: a mid-task line is presented WITH what's already been done, so the model
          // weaves it into the existing plan instead of rewriting the plan from nothing.
          messages.push({
            role: 'user',
            content:
              `You are already mid-task. Results so far:\n${describeTranscript(transcript)}\n` +
              `Take the new message above into account and continue — don't redo finished steps.`,
          });
        }
        budget = MAX_BATCHES;
        lastPlanSig = null;
      }

      if (this.cancel) break;
      if (budget <= 0) {
        // Out of thinking budget for the current line (or nothing to do): wrap up whatever got
        // done, then idle until something new arrives.
        if (transcript.length || assistantRecord) await resolveCurrent('');
        if (!this.pending.length) break;
        continue;
      }
      budget--;

      logger.info(`[loop] planner request (${transcript.length} result(s) so far)`);
      // Rebuilt each turn so a just-issued enterBuildMode/exitBuildMode and the live structural
      // model are reflected immediately.
      const { system, tools } = promptFor();
      // Debug aid: write the exact context the planner is about to see to data/context-dump.md.
      dumpContext({ system, messages, tools, label: `planner (${mode})` });
      const res = await provider.chat({
        system,
        messages,
        tools: mode === 'json' ? [] : tools,
        temperature,
        maxTokens,
      });
      const plan: PlanStep[] =
        mode === 'json' ? parseJsonPlan(res.text) : res.toolCalls.map((c) => ({ name: c.name, args: c.args }));

      // 2) Done turn (no tool calls) — the model considers this line handled.
      if (plan.length === 0) {
        const finalMessage = (mode === 'json' ? extractJsonProse(res.text) : res.text.trim()) || '';
        logger.info(`[loop] planner response: done${finalMessage ? ` — "${finalMessage}"` : ''}`);
        await resolveCurrent(finalMessage);
        if (!this.pending.length) break;
        continue;
      }
      logger.info(`[loop] planner response: ${plan.map((p) => p.name).join(', ')}`);

      // A small JSON model often re-emits the identical, already-successful plan instead of
      // recognizing it's done — treat an exact repeat as done so it can't loop forever.
      const planSig = JSON.stringify(plan.map((p) => [p.name, p.args]));
      if (lastBatchAllOk && planSig === lastPlanSig) {
        logger.info('[loop] same plan as the already-successful last batch — treating as done.');
        await resolveCurrent('');
        if (!this.pending.length) break;
        continue;
      }
      lastPlanSig = planSig;

      // Native models can narrate WHILE calling a tool — speak that immediately. (JSON mode's
      // text is the plan itself, so narration there goes through an explicit sayInChat step.)
      if (mode !== 'json') {
        const narration = res.text.trim();
        if (narration) {
          sendChat(bot, narration);
          assistantRecord += `${narration} `;
        }
      }

      // 3) Execute the batch.
      lastBatchAllOk = true;
      let aborted = false;
      for (let i = 0; i < plan.length; i++) {
        if (this.cancel) break;
        if (this.abortStep) {
          this.abortStep = false;
          aborted = true;
          break;
        }
        const step = plan[i];
        if (this.current) this.current.step = `step ${i + 1}/${plan.length}: ${step.name}`;
        const result = await this.skills.execute(bot, step.name, step.args, ctx);
        transcript.push({ tool: step.name, args: step.args, ok: result.ok, message: result.message });
        assistantRecord += `${describeAction(step.name, step.args, result.message)} `;
        if (this.cancel) break;
        if (this.abortStep) {
          this.abortStep = false;
          aborted = true;
          break;
        }
        // Stop the rest of THIS batch on failure (later steps usually depended on it), but still
        // loop back to the model below so it can decide how to recover.
        if (!result.ok) {
          lastBatchAllOk = false;
          break;
        }
      }

      if (this.cancel) break;
      if (aborted) {
        // An urgent line cut in: loop back; the fold step at the top brings it in WITH the
        // results so far, and the model re-plans from there.
        continue;
      }

      // A batch that was ENTIRELY talk and succeeded is the model's reply — don't ask it to
      // follow up (a small model would just keep rephrasing). Treat the line as handled.
      if (lastBatchAllOk && plan.every((p) => p.name === 'sayInChat')) {
        await resolveCurrent('');
        if (!this.pending.length) break;
        continue;
      }

      // 4) Loop back with the results appended so the model decides what's left.
      messages.push({ role: 'user', content: `Tool results so far:\n${describeTranscript(transcript)}` });
    }

    if (this.cancel) {
      if (assistantRecord.trim()) this.memory.addAssistant(`${assistantRecord.trim()} (stopped)`);
      await this.memory.maybeCompact(this.summarizer());
    }
    this.current = undefined;
  }

  /**
   * Wrap-up for one handled line: speaks a reply (the model's own prose, or a composed summary
   * if it acted without saying anything and didn't already end on sayInChat), records it to
   * memory, and learns from any generated-code/dynamic-skill steps that did real work.
   */
  private async finishResponse(
    bot: Bot,
    task: Task | undefined,
    finalMessage: string,
    transcript: TranscriptEntry[],
    assistantRecord: string,
    lastBatchAllOk: boolean,
  ): Promise<void> {
    let reply = (finalMessage ?? '').trim();
    // If the bot's last step was already sayInChat, it has delivered its answer — a composed
    // wrap-up would just repeat it a beat later in slightly different words.
    const spokeLast = transcript.length > 0 && transcript[transcript.length - 1].tool === 'sayInChat';
    if (!reply && !spokeLast) {
      reply = transcript.length
        ? await this.composeFinalReply(task, transcript)
        : "I'm not sure how to help with that yet.";
    }
    if (reply) sendChat(bot, reply);

    const record = `${assistantRecord}${reply}`.trim();
    this.memory.addAssistant(record || '(no action)');

    const generatedSteps = transcript.filter((t) => t.ok && (t.tool === 'runCode' || this.skills.isDynamic(t.tool)));
    if (lastBatchAllOk && generatedSteps.length && task) {
      recordExperience(
        task.message,
        generatedSteps.map((t) => `${t.tool}(${JSON.stringify(t.args)})`).join('; '),
        reply || 'Completed successfully.',
      );
    }
  }

  /**
   * Composes one natural-language wrap-up from a finished transcript via the cheap "fast" role,
   * instead of mechanically joining raw tool-result strings — falls back to that raw join if the
   * call errors (e.g. "fast" role unavailable).
   */
  private async composeFinalReply(task: Task | undefined, transcript: TranscriptEntry[]): Promise<string> {
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
              `Player "${task?.requestedBy ?? 'someone'}" asked: "${task?.message ?? ''}"\n\n` +
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
  // Location / progress check-ins ("where are you?", "how far?", "are you there yet?", "you close?").
  // These must answer instantly WITHOUT halting the task — asking shouldn't stop the bot.
  if (/\b(where (are|r|ya|u)|how far|how (much )?long|are (you|u|ya) (there|close|here|near)|(you|u|ya) (there|close|near)|almost there|nearly there|reached (it|yet)|got there)\b/.test(m))
    return 'status';
  if (/\b(right now|do it now|stop and|immediately|drop everything|urgent)\b/.test(m)) return 'now';
  return 'task';
}

/** Describes an active pathfinding goal ("traveling toward (x,y,z), ~N blocks to go"), or null
 *  if the bot isn't currently pathing. Reads the live pathfinder goal, so it's LLM-free. */
function describeTravel(bot: Bot): string | null {
  const pf = bot.pathfinder as unknown as {
    isMoving?: () => boolean;
    goal?: { x?: number; y?: number; z?: number; entity?: unknown } | null;
  };
  if (!pf?.isMoving?.()) return null;
  const g = pf.goal;
  if (!g) return 'on the move';
  if (typeof g.x === 'number' && typeof g.y === 'number' && typeof g.z === 'number') {
    const me = bot.entity?.position;
    const togo = me ? Math.round(Math.hypot(me.x - g.x, me.y - g.y, me.z - g.z)) : null;
    const dest = `(${Math.round(g.x)}, ${Math.round(g.y)}, ${Math.round(g.z)})`;
    return togo !== null ? `traveling toward ${dest}, ~${togo} blocks to go` : `traveling toward ${dest}`;
  }
  if (g.entity) return 'traveling toward a moving target';
  return 'on the move';
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
  buildModel: string,
): string {
  const parts = [system];
  if (buildModel) {
    parts.push(
      'BUILDING MODE is ON. Build with absolute coordinates: fillArea for floors/walls/roofs/solid ' +
        'shapes (hollow=true for rooms), buildLine for beams/pillars/edges, placeBlock for single ' +
        'blocks. You have NO vision — inspectArea reads the real blocks (ground, obstacles, what ' +
        'landed) and buildStatus reports the structural model below. Plan in layers from the ground ' +
        'up so each block has support, inspect before and after, and exitBuildMode when finished.\n' +
        `Current structural model:\n${buildModel}`,
    );
  }
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
