/**
 * Dev probe: exercises the real LLM path (LLMManager -> prompt -> model -> parser)
 * without connecting to Minecraft. Run: npx tsx scripts/probeLlm.ts
 */
import { LLMManager } from '../src/llm/LLMManager';
import { SkillRegistry } from '../src/skills/registry';
import { buildJsonSystemPrompt, buildSystemPrompt, parseJsonToolCall } from '../src/llm/promptBuilder';

async function main(): Promise<void> {
  const llm = new LLMManager();
  const skills = new SkillRegistry();
  const provider = llm.forRole('planner');
  const mode = llm.toolMode('planner');
  const tools = skills.toolDefs();

  const messages = [
    'go to coordinates 300 72 180',
    'what is your status?',
    'say hello to everyone',
    'come to me',
  ];

  for (const msg of messages) {
    const userContent =
      `Observation:\nPosition: (310, 73, 169)\nHealth: 20/20\nPlayers nearby: Nish\n\n` +
      `Player "Nish" says: ${msg}`;

    const res = await provider.chat({
      system: mode === 'json' ? buildJsonSystemPrompt('Steve_AI', tools) : buildSystemPrompt('Steve_AI'),
      messages: [{ role: 'user', content: userContent }],
      tools: mode === 'json' ? [] : tools,
      temperature: 0.2,
    });

    console.log('MSG    :', msg);
    if (mode === 'json') {
      console.log('RAW    :', res.text.replace(/\n/g, ' ').slice(0, 200));
      console.log('PARSED :', JSON.stringify(parseJsonToolCall(res.text)));
    } else {
      console.log('TOOLS  :', JSON.stringify(res.toolCalls));
      console.log('TEXT   :', res.text.slice(0, 200));
    }
    console.log('---');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
