# Minecraft LLM Agent

Autonomous, LLM-driven Minecraft agent for **Java Edition**, built on
[Mineflayer](https://github.com/PrismarineJS/mineflayer).

Planning docs:
- [`ARCHITECTURE_PLAN.md`](./ARCHITECTURE_PLAN.md) — research + the "why"
- [`Technical_Approach.md`](./Technical_Approach.md) — full target structure, the "how"
- [`BUILD_ROADMAP.md`](./BUILD_ROADMAP.md) — incremental stage-by-stage build plan

We build **one stage at a time** (see the roadmap). This README covers the current stage.

---

## Current stage: 6 — Agentic loop (chat-driven tasks)

The bot connects, perceives its surroundings (blocks/entities/inventory, refreshed ~3 Hz),
and turns player chat into queued tasks an LLM plans and executes step by step. A 20 Hz
reflex layer keeps it alive between LLM calls (auto-eat, flee creepers, self-defend) without
costing an API call. Real action skills: navigation, gathering, combat, crafting (self-healing
— it pre-crafts missing ingredients and gathers/builds its own crafting table instead of just
failing), equipping, villager trading, and a wide-area search for things not nearby. If a step
in a plan fails, the agent stops that batch, recaps what happened to the LLM, and either
recovers with a corrective plan or explains the failure in chat — instead of blindly running
the rest of a stale plan. See `BUILD_ROADMAP.md` for exactly what's done vs. still ahead.

### Prerequisites
- **Node.js 20+**
- A running **Minecraft Java server** on your PC (one terminal runs the server, another
  runs this agent).

### Setup
```bash
npm install
cp .env.example .env        # keys not needed until Stage 3
```

Edit `config/default.yaml` to match your server:
- `server.auth`: `offline` if the server is offline-mode, otherwise `microsoft`
- `server.version`: leave `""` to auto-detect (or pin e.g. `"1.21.1"`)
- `agent.username`: the bot's name

### Run
```bash
npm start
```
Join the server in your Minecraft client — you should see **`Steve_AI`** spawn and say
**"Agent online."** in chat.

### Useful checks
- `npm run typecheck` — verify the TypeScript compiles.
