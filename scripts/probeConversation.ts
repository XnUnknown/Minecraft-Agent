/**
 * Dev probe: validates conversation memory + compaction + memory-aware action,
 * without connecting to Minecraft. Run: npx tsx scripts/probeConversation.ts
 */
import { LLMManager } from '../src/llm/LLMManager';
import { SkillRegistry } from '../src/skills/registry';
import { ConversationMemory } from '../src/agent/ConversationMemory';
import { buildJsonSystemPrompt, parseJsonToolCall } from '../src/llm/promptBuilder';

async function main(): Promise<void> {
  const llm = new LLMManager();
  const skills = new SkillRegistry();
  const planner = llm.forRole('planner');
  const fast = llm.forRole('fast');
  const tools = skills.toolDefs();

  // Small budget to force compaction quickly.
  const mem = new ConversationMemory({ maxMessages: 4, keepRecent: 2 });
  mem.addUser('Nish', 'my favorite block is diamond');
  mem.addAssistant('Nice, diamonds are great!');
  mem.addUser('Nish', 'remember my home is at 100 64 200');
  mem.addAssistant('Got it — your home is at 100 64 200.');
  mem.addUser('Nish', 'cool, thanks');
  mem.addAssistant("Anytime!");
  await mem.maybeCompact(fast);

  console.log('SUMMARY      :', mem.summaryText());
  console.log('KEPT MESSAGES:', mem.recent().length);

  // New turn that depends on remembered info.
  const finalUser = {
    role: 'user' as const,
    content: 'Observation:\nPosition (0, 64, 0)\n\nPlayer "Nish" says: go to my home',
  };
  const sys = `${buildJsonSystemPrompt('Steve_AI', tools)}\n\nConversation summary so far:\n${mem.summaryText()}`;
  const res = await planner.chat({ system: sys, messages: [...mem.recent(), finalUser], tools: [], temperature: 0.2 });

  console.log('RAW          :', res.text.replace(/\n/g, ' ').slice(0, 200));
  console.log('PARSED ACTION:', JSON.stringify(parseJsonToolCall(res.text)));
  console.log('(expect goToCoordinates x100 y64 z200)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
