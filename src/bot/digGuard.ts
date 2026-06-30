import type { Bot } from 'mineflayer';
import { logger } from '../util/logger';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps `bot.dig` so a deliberate, stationary dig waits for the bot to be settled on the ground
 * before it starts.
 *
 * Why: mineflayer derives a block's dig time from `bot.entity.onGround` (mining while airborne is
 * 5x slower) and runs a *client-side* timer for exactly that long, then tells the server "done".
 * If `dig()` fires while the bot is still settling from a jump/fall/path step, the client picks the
 * wrong dig time, so its timer and the server's disagree: the block visually finishes and vanishes
 * locally, the server hasn't broken it yet, and it only actually breaks after roughly double the
 * time — exactly the stutter we see. Waiting for `onGround` (and near-zero vertical velocity) first
 * keeps the two clocks in sync.
 *
 * Skipped while pathfinder is actively pathing — it owns the bot's motion and digs terrain in
 * stride (sometimes mid-jump), so settling there would fight it. Idempotent per bot.
 */
export function installDigGuard(bot: Bot): void {
  const b = bot as unknown as { __digGuarded?: boolean };
  if (b.__digGuarded) return;
  b.__digGuarded = true;

  const origDig = bot.dig.bind(bot);
  bot.dig = (async (block: unknown, forceLook?: unknown, digFace?: unknown) => {
    const pf = bot.pathfinder as { isMoving?: () => boolean } | undefined;
    if (!pf?.isMoving?.()) await settle(bot);
    return origDig(block as never, forceLook as never, digFace as never);
  }) as typeof bot.dig;

  logger.info('Dig guard installed: settle on ground before a standalone dig (fixes 2x break desync).');
}

/** Stop drifting and wait (briefly, bounded) until the bot is grounded and vertically still. */
async function settle(bot: Bot): Promise<void> {
  try {
    bot.clearControlStates();
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 600;
  while (Date.now() < deadline) {
    const e = bot.entity;
    if (e?.onGround && Math.abs(e.velocity?.y ?? 0) < 0.05) return;
    await sleep(50);
  }
}
