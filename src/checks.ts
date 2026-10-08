import { spawn } from 'node:child_process';
import type { Check } from './config.js';

export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** Tail of combined stdout/stderr. */
  output: string;
}

const OUTPUT_TAIL = 6000;

/** Runs a shell command in the repo. This is plain software, not an agent: the AI cannot fake a pass. */
export function runCheck(check: Check, cwd: string, timeoutSec: number): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(check.command, { cwd, shell: true, env: { ...process.env, CI: 'true', FORCE_COLOR: '0' } });
    let output = '';
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_TAIL * 2) output = output.slice(-OUTPUT_TAIL);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // With shell: true, killing the shell alone would orphan the actual command on Windows.
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    }, timeoutSec * 1000);
    const finish = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      resolve({
        name: check.name,
        command: check.command,
        passed: !timedOut && exitCode === 0,
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
        output: (output + extra).slice(-OUTPUT_TAIL),
      });
    };
    child.on('error', (err) => finish(null, `\n${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

export async function runChecks(checks: Check[], cwd: string, timeoutSec: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await runCheck(check, cwd, timeoutSec));
  return results;
}
