import type { Bot } from 'mineflayer';
import { logger } from '../util/logger';

const PATH_LINE_ID = 'pathfinder-path';
const PATH_NODES_ID = 'pathfinder-path-nodes';
/** Bright green "glow" for the live A* path, distinct from the world's natural colors. */
const PATH_COLOR = 0x39ff14;

interface Point {
  x: number;
  y: number;
  z: number;
}

/** The methods prismarine-viewer bolts onto `bot.viewer` at runtime — untyped upstream. */
interface ViewerHandle {
  drawLine(id: string, points: Point[], color?: number): void;
  drawPoints(id: string, points: Point[], color?: number, size?: number): void;
  erase(id: string): void;
  close(): void;
}

function viewerOf(bot: Bot): ViewerHandle | undefined {
  return (bot as unknown as { viewer?: ViewerHandle }).viewer;
}

interface PovState {
  port: number;
  onPathUpdate: (results: { path: Point[] }) => void;
  onGoalReached: () => void;
}

/** Keyed by bot instance, not module-level — multi-agent mode can run several bots (and
 *  therefore several viewers, on different ports) in the same process. */
const sessions = new WeakMap<Bot, PovState>();

/**
 * Starts the 3D POV viewer (prismarine-viewer) on `viewPort` and wires it to redraw the
 * bot's live A* path as a glowing line + node markers every time mineflayer-pathfinder
 * recomputes one, clearing it when the goal is reached. Safe to call again while already
 * running (no-op, just re-reports the URL).
 *
 * prismarine-viewer is loaded lazily (only when this is actually called), not imported at
 * module load time — it pulls in `canvas`, a native module that can fail to load on some
 * machines/Node versions. A failure here is reported back as a normal result; it must never
 * crash the whole agent just because the viewer (a debug/visualization extra) isn't usable.
 */
export async function startPov(bot: Bot, viewPort: number): Promise<{ ok: boolean; message: string }> {
  const existing = sessions.get(bot);
  if (existing) {
    return { ok: true, message: `POV viewer already running — open http://localhost:${existing.port} in a browser.` };
  }

  try {
    const { mineflayer: injectViewer } = await import('prismarine-viewer');
    injectViewer(bot, { port: viewPort, viewDistance: 8, firstPerson: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`POV viewer unavailable: ${msg}`);
    return { ok: false, message: `Couldn't start the POV viewer (${msg}).` };
  }

  const onPathUpdate = (results: { path: Point[] }): void => {
    const viewer = viewerOf(bot);
    if (!viewer) return;
    const path = results.path ?? [];
    if (!path.length) {
      viewer.erase(PATH_LINE_ID);
      viewer.erase(PATH_NODES_ID);
      return;
    }
    // Path nodes are floored block coordinates — center the glow in each block, not its corner.
    const points = path.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }));
    viewer.drawLine(PATH_LINE_ID, points, PATH_COLOR);
    viewer.drawPoints(PATH_NODES_ID, points, PATH_COLOR, 8);
  };
  const onGoalReached = (): void => {
    const viewer = viewerOf(bot);
    viewer?.erase(PATH_LINE_ID);
    viewer?.erase(PATH_NODES_ID);
  };

  bot.on('path_update', onPathUpdate);
  bot.on('goal_reached', onGoalReached);
  sessions.set(bot, { port: viewPort, onPathUpdate, onGoalReached });

  logger.info(`POV viewer running at http://localhost:${viewPort} (reachable on your LAN, not just localhost).`);
  return { ok: true, message: `POV viewer running — open http://localhost:${viewPort} in a browser.` };
}

/** Stops this bot's viewer and unwires its path listeners. Safe to call even if not running. */
export function stopPov(bot: Bot): { ok: boolean; message: string } {
  const session = sessions.get(bot);
  if (!session) return { ok: true, message: 'POV viewer is not running.' };

  viewerOf(bot)?.close();
  bot.removeListener('path_update', session.onPathUpdate);
  bot.removeListener('goal_reached', session.onGoalReached);
  sessions.delete(bot);
  return { ok: true, message: 'POV viewer stopped.' };
}

export function isPovRunning(bot: Bot): boolean {
  return sessions.has(bot);
}
