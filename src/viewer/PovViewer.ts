import type { Bot } from 'mineflayer';
import { mineflayer as injectViewer } from 'prismarine-viewer';
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

/**
 * Module-level state: one POV viewer per process. Fine while the agent is single-bot;
 * will need to move onto a per-bot instance once multi-agent support lands.
 */
let running = false;
let port = 0;
let onPathUpdate: ((results: { path: Point[] }) => void) | undefined;
let onGoalReached: (() => void) | undefined;

/**
 * Starts the 3D POV viewer (prismarine-viewer) on `viewPort` and wires it to redraw the
 * bot's live A* path as a glowing line + node markers every time mineflayer-pathfinder
 * recomputes one, clearing it when the goal is reached. Safe to call again while already
 * running (no-op, just re-reports the URL).
 */
export function startPov(bot: Bot, viewPort: number): { ok: boolean; message: string } {
  if (running) {
    return { ok: true, message: `POV viewer already running — open http://localhost:${port} in a browser.` };
  }

  try {
    injectViewer(bot, { port: viewPort, viewDistance: 8, firstPerson: false });
  } catch (err) {
    return { ok: false, message: `Couldn't start the POV viewer: ${err instanceof Error ? err.message : String(err)}` };
  }

  onPathUpdate = (results): void => {
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
  onGoalReached = (): void => {
    const viewer = viewerOf(bot);
    viewer?.erase(PATH_LINE_ID);
    viewer?.erase(PATH_NODES_ID);
  };

  bot.on('path_update', onPathUpdate);
  bot.on('goal_reached', onGoalReached);

  running = true;
  port = viewPort;
  logger.info(`POV viewer running at http://localhost:${viewPort} (reachable on your LAN, not just localhost).`);
  return { ok: true, message: `POV viewer running — open http://localhost:${viewPort} in a browser.` };
}

/** Stops the viewer and unwires the path listeners. Safe to call even if not running. */
export function stopPov(bot: Bot): { ok: boolean; message: string } {
  if (!running) return { ok: true, message: 'POV viewer is not running.' };

  viewerOf(bot)?.close();
  if (onPathUpdate) bot.removeListener('path_update', onPathUpdate);
  if (onGoalReached) bot.removeListener('goal_reached', onGoalReached);
  onPathUpdate = undefined;
  onGoalReached = undefined;
  running = false;
  return { ok: true, message: 'POV viewer stopped.' };
}

export function isPovRunning(): boolean {
  return running;
}
