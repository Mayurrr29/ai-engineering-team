const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};

export interface Logger {
  stage(index: number, title: string): void;
  info(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
  fail(message: string): void;
  activity(message: string): void;
  raw(message: string): void;
}

export function consoleLogger(verbose = true): Logger {
  return {
    stage: (i, title) => console.log(`\n${c.bold(c.cyan(`[${i}] ${title}`))}`),
    info: (m) => console.log(`  ${m}`),
    ok: (m) => console.log(`  ${c.green('✓')} ${m}`),
    warn: (m) => console.log(`  ${c.yellow('!')} ${m}`),
    fail: (m) => console.log(`  ${c.red('✗')} ${m}`),
    activity: (m) => {
      if (verbose) console.log(c.dim(`    · ${m}`));
    },
    raw: (m) => console.log(m),
  };
}

export const silentLogger: Logger = {
  stage() {},
  info() {},
  ok() {},
  warn() {},
  fail() {},
  activity() {},
  raw() {},
};

export function banner(lines: Array<[string, string]>, status: string): string {
  const rule = '━'.repeat(34);
  const width = Math.max(...lines.map(([k]) => k.length)) + 2;
  return [
    rule,
    '             RELEASE',
    rule,
    '',
    ...lines.map(([k, v]) => `${(k + ':').padEnd(width)} ${colorStatus(v)}`),
    '',
    `STATUS: ${status}`,
    rule,
  ].join('\n');
}

function colorStatus(v: string): string {
  if (v.startsWith('PASS')) return c.green(v);
  if (v.startsWith('FAIL')) return c.red(v);
  if (v.startsWith('SKIPPED') || v.startsWith('PENDING')) return c.dim(v);
  return v;
}
