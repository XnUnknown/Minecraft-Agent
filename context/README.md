# `context/` — the agent's predefined system prompt

These markdown files ARE the static/predefined part of the prompt the planner LLM receives
every turn. Edit them to change how the agent thinks; the code reads them — there is no other
copy. (`src/llm/contextLoader.ts` loads them; `src/llm/promptBuilder.ts` calls it.)

## Layout

- `native/` — used when the provider does NATIVE tool calling (OpenAI / Claude / gpt-oss).
- `json/` — used when the provider is a JSON-mode model (e.g. Ollama Gemma). This is the
  default planner today.

Only one of these is used per run, depending on the configured planner provider.

## How files become the prompt

- Every `.md` file in the active mode's folder is concatenated **in filename order**, so the
  numeric prefixes (`00-`, `10-`, `20-` …) control section order. Renumber to reorder; delete a
  file to drop that section; add a new `NN-something.md` to add one.
- Placeholders substituted at build time:
  - `{{botName}}` — the bot's username (both modes).
  - `{{tools}}` — the auto-generated tool catalog (json mode only; reflects the actually
    registered tools, so don't hand-maintain a tool list here).
- A file ending in `.code.md` is the sandbox/`runCode` section — it's included **only when**
  `skills.codeExecution: true` in `config/default.yaml`, and omitted otherwise.

## Loaded once (here) vs. fresh every turn (not here)

These files are read from disk **once per process and cached** (the static context). After
editing them, restart the agent (or in `npm run dev`, saving a file under `context/` triggers a
nodemon restart) for changes to take effect.

The **volatile** context is deliberately NOT in this folder and is rebuilt fresh on every turn,
appended after this static prompt by `goalRunner.ts`:

- the live world **observation**,
- the **conversation summary** (memory),
- **crafting experience** (`data/agent_experience.md` / learned recipes),
- **agent experience** (learned task approaches),
- the **other-agents** note (depends on which peers are online).

So edit these files for durable behavior; the runtime knowledge updates itself.
