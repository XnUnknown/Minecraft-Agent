import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config/loadConfig';

/**
 * Convenience launcher for the "N separate processes" multi-agent model: spawns one child
 * process per configured agent (each with AGENT_NAME set, so src/index.ts boots only that
 * one profile), prefixing every line of output so the logs stay distinguishable in one
 * terminal. Equivalent to running `AGENT_NAME=<username> npm start` in N separate terminals
 * yourself — this just does it for you. The other multi-agent model (one process, N bots)
 * is just `npm start` with more than one entry under `agents:` in config/default.yaml.
 */
function main(): void {
  const config = loadConfig();
  if (config.agents.length < 2) {
    console.error('Only one agent is configured — nothing to launch separately. Add more under `agents:` in config/default.yaml.');
    process.exit(1);
  }

  for (const profile of config.agents) {
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      env: { ...process.env, AGENT_NAME: profile.username },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    prefixLines(child.stdout, profile.username, process.stdout);
    prefixLines(child.stderr, profile.username, process.stderr);

    child.on('exit', (code) => {
      console.log(`[${profile.username}] process exited (code ${code}).`);
    });
  }
}

function prefixLines(stream: NodeJS.ReadableStream, label: string, out: NodeJS.WritableStream): void {
  let buffered = '';
  stream.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) out.write(`[${label}] ${line}\n`);
  });
}

main();
