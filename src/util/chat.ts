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
