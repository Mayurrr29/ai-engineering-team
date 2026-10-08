import type { ColorName } from '../team.js';

const enabled = () => !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0' && (process.stdout.isTTY || !!process.env.FORCE_COLOR);

const CODES: Record<ColorName | 'bold' | 'dim' | 'italic' | 'inverse', [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  inverse: [7, 27],
  cyan: [36, 39],
  magenta: [35, 39],
  blue: [34, 39],
  yellow: [33, 39],
  green: [32, 39],
  white: [97, 39],
  brightMagenta: [95, 39],
  brightBlue: [94, 39],
  red: [31, 39],
  gray: [90, 39],
};

function wrap(name: keyof typeof CODES) {
  return (s: string) => (enabled() ? `\x1b[${CODES[name][0]}m${s}\x1b[${CODES[name][1]}m` : s);
}

export const c = Object.fromEntries(Object.keys(CODES).map((k) => [k, wrap(k as keyof typeof CODES)])) as Record<keyof typeof CODES, (s: string) => string>;

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff)
  )
    return 2;
  return 1;
}

/** Display width in terminal cells (ANSI codes ignored, emoji counted as two cells). */
export function width(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Truncates to a display width, keeping ANSI styling balanced by resetting at the end. */
export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const ansi = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (ansi) {
      out += ansi[0];
      i += ansi[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}…${enabled() ? '\x1b[0m' : ''}`;
}

export function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function supportsEmoji(): boolean {
  if (process.env.AI_TEAM_NO_EMOJI) return false;
  // Legacy Windows console hosts can't render emoji; modern terminals set one of these.
  if (process.platform === 'win32') return !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.VSCODE_PID || process.env.ConEmuANSI);
  return true;
}
