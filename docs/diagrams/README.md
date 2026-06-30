# Architecture diagrams

Mermaid sources + rendered images for the agent's architecture.

| Diagram | Source | Image |
|---|---|---|
| High-level (subsystems + data flow) | [`high-level.mmd`](./high-level.mmd) | [`high-level.png`](./high-level.png) · [`.svg`](./high-level.svg) |
| Low-level (one chat line through the agent) | [`low-level.mmd`](./low-level.mmd) | [`low-level.png`](./low-level.png) · [`.svg`](./low-level.svg) |

## Regenerating the images

The `.mmd` files are the source of truth — edit them, then re-render with
[`@mermaid-js/mermaid-cli`](https://github.com/mermaid-js/mermaid-cli):

```bash
# Uses an already-installed Chrome/Edge instead of downloading Chromium.
# puppeteer.json: { "executablePath": "<path to chrome.exe>", "args": ["--no-sandbox"] }
export PUPPETEER_SKIP_DOWNLOAD=true
npx -y @mermaid-js/mermaid-cli@11 -i high-level.mmd -o high-level.png -p puppeteer.json -b white -w 1700
npx -y @mermaid-js/mermaid-cli@11 -i low-level.mmd  -o low-level.png  -p puppeteer.json -b white -w 2200
# add -o <name>.svg for the scalable version
```

GitHub also renders the `.mmd` blocks inline if you paste them into a fenced ` ```mermaid ` block.
