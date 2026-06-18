/**
 * Dev probe: validates multi-step PLAN generation (gather + combat + give).
 * Run: npx tsx scripts/probePlan.ts
 */
import { LLMManager } from '../src/llm/LLMManager';
import { SkillRegistry } from '../src/skills/registry';
import { buildJsonSystemPrompt, parseJsonPlan } from '../src/llm/promptBuilder';

async function main(): Promise<void> {
  const llm = new LLMManager();
  const skills = new SkillRegistry();
  const provider = llm.forRole('planner');
  const tools = skills.toolDefs();

  const requests = [
    'go bring me some wood',
    'kill the monsters around here',
    'get me 5 wood and then kill 2 zombies',
    'come say hi to me',
  ];

  for (const msg of requests) {
    const userContent =
      `Observation:\nPosition (62, -60, 144)\nPlayers nearby: Nish\nMobs nearby: 3x zombie\nInventory: empty\n\n` +
      `Player "Nish" says: ${msg}`;
    const res = await provider.chat({
      system: buildJsonSystemPrompt('Steve_AI', tools),
      messages: [{ role: 'user', content: userContent }],
      tools: [],
      temperature: 0.2,
    });
    console.log('REQUEST:', msg);
    console.log('PLAN   :', JSON.stringify(parseJsonPlan(res.text)));
    console.log('---');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
