# Minecraft LLM Agent

Autonomous, LLM-driven Minecraft agent for **Java Edition**, built on
[Mineflayer](https://github.com/PrismarineJS/mineflayer).

Planning docs:
- [`ARCHITECTURE_PLAN.md`](./ARCHITECTURE_PLAN.md) — research + the "why"
- [`Technical_Approach.md`](./Technical_Approach.md) — full target structure, the "how"
- [`BUILD_ROADMAP.md`](./BUILD_ROADMAP.md) — incremental stage-by-stage build plan

We build **one stage at a time** (see the roadmap). This README covers the current stage.

---

## Current stage: 1 — Simple join agent

The bot connects to your local server, spawns, greets in chat, and auto-reconnects.
No AI yet — this just proves the body connects.

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
