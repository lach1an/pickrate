import { existsSync } from 'node:fs';

export type Target =
  | { kind: 'http'; url: string; display: string }
  | { kind: 'file'; path: string; display: string }
  | { kind: 'stdio'; command: string; args: string[]; display: string };

/**
 * Work out what the user pointed us at.
 *
 *   https://api.example.com/mcp   → streamable HTTP
 *   ./manifest.json               → a captured tools/list response
 *   node ./build/index.js         → stdio subprocess
 */
export function parseTarget(input: string): Target {
  const raw = input.trim();
  if (raw === '') throw new Error('Empty target.');

  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'http', url: raw, display: raw };
  }

  if (/\.json$/i.test(raw) && existsSync(raw)) {
    return { kind: 'file', path: raw, display: raw };
  }

  const parts = splitCommand(raw);
  const [command, ...args] = parts;
  if (command === undefined) throw new Error(`Could not parse target: ${input}`);
  return { kind: 'stdio', command, args, display: raw };
}

/** Minimal shell-style splitter: whitespace separated, honours ' and ". */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) throw new Error(`Unbalanced ${quote} in command: ${input}`);
  if (started) out.push(current);
  return out;
}
