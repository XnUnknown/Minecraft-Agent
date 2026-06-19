/** Real Minecraft chat protocol cap — messages longer than this get rejected/cut by the server. */
const MAX_CHAT_LEN = 256;

/** Splits a message into <=256-char chunks on word boundaries, instead of truncating it. */
export function chunkForChat(message: string, maxLen = MAX_CHAT_LEN): string[] {
  const trimmed = message.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Sends a (possibly long) message to chat as multiple lines instead of silently truncating it. */
export function sendChat(bot: { chat(msg: string): void }, message: string): void {
  for (const chunk of chunkForChat(message)) bot.chat(chunk);
}

/** How long a "we just said this" record is trusted as our own echo, not a new player message. */
const SELF_ECHO_WINDOW_MS = 5000;
const recentlySent: Array<{ text: string; at: number }> = [];

function normalizeForCompare(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Records a message we just sent (call this from wherever `bot.chat` is actually invoked —
 * see createBot.ts, which wraps it once so every send path is covered automatically). The
 * server echoes our own messages back through the same 'chat' event as player messages; some
 * server chat-formatting plugins rewrite the username on that echo, so matching on username
 * alone isn't reliable — `wasRecentlySent` is the text-based backstop for that case.
 */
export function recordSent(message: string): void {
  const now = Date.now();
  recentlySent.push({ text: normalizeForCompare(message), at: now });
  while (recentlySent.length && now - recentlySent[0].at > SELF_ECHO_WINDOW_MS) recentlySent.shift();
}

/** True if `message` matches something we ourselves sent within the last few seconds. */
export function wasRecentlySent(message: string): boolean {
  const now = Date.now();
  const text = normalizeForCompare(message);
  return recentlySent.some((e) => now - e.at <= SELF_ECHO_WINDOW_MS && e.text === text);
}
