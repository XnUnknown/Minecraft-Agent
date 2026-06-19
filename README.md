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

### Watching it work (3D viewer)
Say **`pov`** in chat (or type it as the agent's own player if testing solo) to open a live
3D view: `http://localhost:3000` (port set by `viewer.port` in `config/default.yaml`) in your
browser, in its own window alongside the Minecraft client. It shows what the bot perceives
and draws its current A* path as a glowing line in real time. Say **`pov off`** to stop it.
Note: the viewer's web server listens on all network interfaces, not just localhost.

### Running multiple agents
Add an `agents:` list to `config/default.yaml` (see the commented example there) — each
entry is one bot's username. With only one agent (the default), chat needs no name, same
as always. With more than one, name who a message is for, anywhere in the text — e.g.
"Steve_AI1 Steve_AI2 collect some wood" addresses both; an unnamed message is ignored by
everyone once there's more than one agent.

Two ways to actually run them, same behavior either way:
- **One process, N bots:** just `npm start` — it boots every agent in `agents:`.
- **N separate processes:** `AGENT_NAME=Steve_AI1 npm start` runs only that one profile;
  repeat per agent in separate terminals, or let `npm run start:multi` spawn one child
  process per agent for you (prefixes each one's log lines).

Agents can ask each other for help via chat (the `messageAgent` tool) — e.g. "ask
Steve_AI2 to bring 4 oak_log to Steve_AI1." The asked agent either does it and delivers,
or replies that it's busy right now instead of silently queuing behind its current job.

### Useful checks
- `npm run typecheck` — verify the TypeScript compiles.
