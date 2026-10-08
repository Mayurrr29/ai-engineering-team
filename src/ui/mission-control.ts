import type { ReleaseDecision } from '../release.js';
import type { RunState } from '../state.js';
import { MEMBERS, nameOf, ROSTER_ORDER, type Actor, type RoleId, type TeamNames } from '../team.js';
import { c, fmtElapsed, pad, truncate, width } from './format.js';
import { printFinish } from './finish.js';
import type { LogKind, MemberStatus, TeamUI } from './types.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Row {
  status: MemberStatus;
  detail: string;
  since: number;
  activity?: string;
}

export interface UIOptions {
  names: TeamNames;
  emoji: boolean;
  /** Show tool-level activity (Read/Edit/Bash...). */
  verbose: boolean;
}

function icon(role: RoleId | 'gate', emoji: boolean): string {
  return emoji ? MEMBERS[role].icon : `${MEMBERS[role].defaultName[0]} `;
}

export function actorLabel(actor: Actor | undefined, opts: UIOptions): string {
  if (!actor || actor === 'system') return c.gray('team    ');
  if (actor === 'human') return c.bold('you     ');
  const m = MEMBERS[actor];
  return c[m.color](c.bold(pad(nameOf(actor, opts.names), 8)));
}

export function logLine(kind: LogKind, text: string, actor: Actor | undefined, opts: UIOptions): string {
  const mark = { info: c.gray('·'), ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), event: c.cyan('◆') }[kind];
  return `  ${mark} ${actorLabel(actor, opts)} ${text}`;
}

/** Shared roster state for both the live panel and the plain logger. */
class Roster {
  rows = new Map<RoleId | 'gate', Row>();
  state?: RunState;

  constructor() {
    for (const r of ROSTER_ORDER) this.rows.set(r, { status: 'idle', detail: '', since: Date.now() });
  }

  set(role: RoleId | 'gate', status: MemberStatus, detail = '') {
    const row = this.rows.get(role)!;
    if (row.status !== status) row.since = Date.now();
    row.status = status;
    row.detail = detail;
    if (status !== 'working') row.activity = undefined;
  }

  /** Recomputes idle members from the lineup: who is queued, who isn't needed. */
  sync(state: RunState) {
    this.state = state;
    const planned = !!state.plan;
    for (const role of ROSTER_ORDER) {
      const row = this.rows.get(role)!;
      if (row.status === 'working' || row.status === 'done' || row.status === 'failed') continue;
      if (role === 'lead') row.status = planned ? 'done' : 'queued';
      else if (role === 'gate') row.status = 'waiting';
      else if (role === 'bugFixer') row.status = 'oncall';
      else if (role === 'developer') row.status = planned ? 'queued' : 'idle';
      else if (!planned) row.status = 'idle';
      else row.status = state.lineup[role] === 'off' ? 'skipped' : 'queued';
      if (row.status === 'skipped') row.detail = 'not needed for this mission';
      if (row.status === 'oncall') row.detail = 'joins only if something breaks';
      if (role === 'gate' && row.status === 'waiting') row.detail = 'checks every verdict at the end';
      if (row.status === 'queued' && role !== 'developer' && role !== 'lead' && role !== 'gate') row.detail = `${state.lineup[role as 'pm']} depth`;
    }
  }
}

/** Live-updating team panel for interactive terminals, with logs scrolling above it. */
export class MissionControl implements TeamUI {
  private roster = new Roster();
  private height = 0;
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private suspended = false;
  private state?: RunState;

  constructor(private readonly opts: UIOptions) {}

  start(state: RunState) {
    this.state = state;
    this.roster.sync(state);
    process.stdout.write('\x1b[?25l');
    const restore = () => process.stdout.write('\x1b[?25h');
    process.once('exit', restore);
    this.timer = setInterval(() => this.paint(), 100);
    this.timer.unref();
    this.paint();
  }

  update(state: RunState) {
    this.state = state;
    this.roster.sync(state);
    this.paint();
  }

  member(role: RoleId | 'gate', status: MemberStatus, detail?: string) {
    const before = this.roster.rows.get(role)!.status;
    this.roster.set(role, status, detail ?? '');
    if (this.state) this.roster.sync(this.state);
    // Finished work also goes into the scrolling history above the panel.
    if (status === 'done' && detail) this.print(logLine(role === 'gate' ? 'event' : 'ok', detail, role, this.opts));
    else if (status === 'failed' && before !== 'failed') this.print(logLine('fail', detail ?? 'failed', role, this.opts));
    else this.paint();
  }

  activity(role: RoleId, line: string) {
    const row = this.roster.rows.get(role);
    if (row) row.activity = line;
  }

  log(kind: LogKind, text: string, actor?: Actor) {
    this.print(logLine(kind, text, actor, this.opts));
  }

  suspend() {
    this.clear();
    this.suspended = true;
    process.stdout.write('\x1b[?25h');
  }

  resume() {
    this.suspended = false;
    process.stdout.write('\x1b[?25l');
    this.paint();
  }

  finish(state: RunState, decision?: ReleaseDecision, reportPath?: string) {
    this.state = state;
    this.roster.sync(state);
    this.paint();
    if (this.timer) clearInterval(this.timer);
    this.height = 0;
    process.stdout.write('\x1b[?25h\n');
    printFinish(state, decision, reportPath, this.opts);
  }

  private print(line: string) {
    if (this.suspended) {
      process.stdout.write(`${line}\n`);
      return;
    }
    this.clear();
    process.stdout.write(`${truncate(line, this.columns())}\n`);
    this.paint();
  }

  private clear() {
    if (this.height > 0) process.stdout.write(`\x1b[${this.height}A\x1b[0J`);
    this.height = 0;
  }

  private columns() {
    return Math.max(40, (process.stdout.columns || 100) - 1);
  }

  private paint() {
    if (this.suspended || !this.state) return;
    this.frame = (this.frame + 1) % SPINNER.length;
    const lines = this.render(this.state).map((l) => truncate(l, this.columns()));
    let out = this.height > 0 ? `\x1b[${this.height}A\x1b[0J` : '';
    out += lines.join('\n') + '\n';
    process.stdout.write(out);
    this.height = lines.length;
  }

  private render(state: RunState): string[] {
    const { names, emoji } = this.opts;
    const elapsed = fmtElapsed(Date.now() - new Date(state.createdAt).getTime());
    const budget = state.budgetUsd ? ` / $${state.budgetUsd.toFixed(2)}` : '';
    const right = c.gray(`${elapsed} · $${state.costUsd.toFixed(2)}${budget} · round ${state.iteration}/${state.maxIterations}`);
    const title = `${c.bold(c.cyan('AI ENGINEERING TEAM'))} ${c.gray('▸')} ${c.bold(state.plan?.missionName ?? 'Planning the mission…')}`;
    const cols = this.columns();
    const gap = Math.max(2, cols - width(title) - width(right) - 2);
    const lines = [``, ` ${title}${' '.repeat(gap)}${right}`, c.gray(` ${'─'.repeat(Math.min(cols - 2, 96))}`)];
    for (const role of ROSTER_ORDER) {
      const row = this.roster.rows.get(role)!;
      const m = MEMBERS[role];
      const dim = row.status === 'skipped' || row.status === 'idle';
      const name = dim ? c.gray(pad(nameOf(role, names), 9)) : c[m.color](c.bold(pad(nameOf(role, names), 9)));
      const title = c.gray(pad(m.title, 18));
      const mark = this.mark(row.status);
      const extra = row.status === 'working' ? c.gray(` · ${fmtElapsed(Date.now() - row.since)}`) : '';
      const detail = dim ? c.gray(row.detail) : row.detail;
      lines.push(`  ${icon(role, emoji)} ${name} ${title} ${mark} ${detail}${extra}`);
      if (row.status === 'working' && row.activity && this.opts.verbose) lines.push(c.gray(`  ${' '.repeat(2 + 1 + 9 + 1 + 18 + 1)}↳ ${row.activity}`));
    }
    return lines;
  }

  private mark(status: MemberStatus): string {
    switch (status) {
      case 'working':
        return c.cyan(SPINNER[this.frame]);
      case 'done':
        return c.green('✓');
      case 'failed':
        return c.red('✗');
      case 'queued':
        return c.gray('○');
      case 'skipped':
        return c.gray('–');
      default:
        return c.gray('·');
    }
  }
}

/** Line-by-line output for CI, pipes and terminals without live rendering. */
export class PlainUI implements TeamUI {
  private roster = new Roster();
  private lastActivity = new Map<RoleId, number>();

  constructor(private readonly opts: UIOptions) {}

  start(state: RunState) {
    this.roster.sync(state);
    console.log(`\n${c.bold(c.cyan('AI ENGINEERING TEAM'))} ${c.gray(`· mission ${state.id}`)}`);
  }

  update(state: RunState) {
    this.roster.sync(state);
  }

  member(role: RoleId | 'gate', status: MemberStatus, detail?: string) {
    const before = this.roster.rows.get(role)!.status;
    this.roster.set(role, status, detail ?? '');
    if (status === 'working' && before !== 'working') console.log(logLine('info', `${detail ?? 'working'}…`, role, this.opts));
    else if (status === 'done') console.log(logLine('ok', detail ?? 'done', role, this.opts));
    else if (status === 'failed') console.log(logLine('fail', detail ?? 'failed', role, this.opts));
  }

  activity(role: RoleId, line: string) {
    if (!this.opts.verbose) return;
    const now = Date.now();
    if (now - (this.lastActivity.get(role) ?? 0) < 250) return;
    this.lastActivity.set(role, now);
    console.log(c.gray(`      ${nameOf(role, this.opts.names)} ↳ ${line}`));
  }

  log(kind: LogKind, text: string, actor?: Actor) {
    console.log(logLine(kind, text, actor, this.opts));
  }

  suspend() {}
  resume() {}

  finish(state: RunState, decision?: ReleaseDecision, reportPath?: string) {
    printFinish(state, decision, reportPath, this.opts);
  }
}
