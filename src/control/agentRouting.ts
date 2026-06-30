/** Escapes a string for safe use inside a RegExp literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scans `message` for any `knownNames` entry as a whole word, anywhere in the text
 * (case-insensitive) — not just a leading prefix, since multiple agents can be addressed
 * together, e.g. "Steve_AI1 Steve_AI2 collect wood". Returns every matched name (in their
 * configured casing) plus the message with those name-tokens stripped out.
 */
export function parseTargets(message: string, knownNames: string[]): { targets: string[]; rest: string } {
  const targets: string[] = [];
  let rest = message;

  for (const name of knownNames) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
    if (pattern.test(rest)) {
      targets.push(name);
      rest = rest.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'ig'), ' ');
    }
  }

  return { targets, rest: rest.replace(/\s+/g, ' ').trim() };
}
