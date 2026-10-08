import fs from 'node:fs';
import path from 'node:path';
import { evaluateRelease, type GateStatus, type ReleaseDecision } from '../release.js';
import { mermaidSource } from '../render.js';
import type { Severity } from '../schemas.js';
import type { RunState, RunStore, TeamEvent } from '../state.js';
import { MEMBERS, nameOf, ROSTER_ORDER, type Actor, type RoleId, type TeamNames } from '../team.js';
import { TEMPLATES_DIR } from '../paths.js';

export interface ReportOptions {
  names: TeamNames;
  checksConfigured: boolean;
  humanName?: string;
}

/** Writes report.html into the mission folder and returns its path. */
export function writeReport(store: RunStore, opts: ReportOptions): string {
  const file = path.join(store.dir, 'report.html');
  fs.writeFileSync(file, renderReport(store.state, opts));
  return file;
}

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Inline code spans in agent text → <code>. Everything else escaped. */
const rich = (value: unknown) => esc(value).replace(/`([^`]+)`/g, '<code>$1</code>');

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'info';
const STATUS_ICON: Record<Tone, string> = { good: '✓', bad: '✗', warn: '!', neutral: '–', info: '●' };

function chip(label: string, tone: Tone, title?: string): string {
  return `<span class="chip chip-${tone}"${title ? ` title="${esc(title)}"` : ''}><span class="chip-dot" aria-hidden="true">${STATUS_ICON[tone]}</span>${esc(label)}</span>`;
}

const gateTone = (s: GateStatus): Tone => (s === 'PASS' ? 'good' : s === 'FAIL' ? 'bad' : s === 'WARN' ? 'warn' : 'neutral');
const sevTone = (s: Severity): Tone => (s === 'CRITICAL' ? 'bad' : s === 'HIGH' ? 'bad' : s === 'MEDIUM' ? 'warn' : 'neutral');
const resultTone = (r: string): Tone => (r === 'PASS' || r === 'DONE' || r === 'FIXED' || r === 'APPROVED' ? 'good' : r === 'FAIL' || r === 'NOT_DONE' || r === 'REJECTED' || r === 'NOT_FIXED' ? 'bad' : r === 'PARTIAL' ? 'warn' : 'neutral');

function avatar(actor: Actor, names: TeamNames, size = 'md'): string {
  if (actor === 'human' || actor === 'system') {
    const label = actor === 'human' ? 'You' : 'System';
    return `<span class="avatar avatar-${size} avatar-plain" title="${label}" aria-hidden="true">${actor === 'human' ? '🙂' : '⚙'}</span>`;
  }
  const m = MEMBERS[actor];
  return `<span class="avatar avatar-${size}" style="--m:${m.hex};--m-dark:${m.hexDark}" title="${esc(nameOf(actor, names))}" aria-hidden="true">${m.icon}</span>`;
}

function actorName(actor: Actor | 'team', names: TeamNames): string {
  if (actor === 'human') return 'You';
  if (actor === 'system') return 'Orchestrator';
  if (actor === 'team') return 'Team';
  return nameOf(actor, names);
}

function section(id: string, title: string, body: string, subtitle = ''): string {
  if (!body.trim()) return '';
  return `<section class="card" id="${id}"><header class="card-head"><h2>${esc(title)}</h2>${subtitle ? `<p class="muted">${subtitle}</p>` : ''}</header>${body}</section>`;
}

function list(items: string[]): string {
  return items.length ? `<ul class="list">${items.map((i) => `<li>${rich(i)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>';
}

// ── Sections ──────────────────────────────────────────────────────────────

function hero(state: RunState, decision: ReleaseDecision | undefined, names: TeamNames): string {
  const status = state.status;
  const label =
    status === 'approved' ? 'APPROVED' : status === 'rejected' ? 'REJECTED' : status === 'paused' ? 'PAUSED' : status === 'failed' ? 'NEEDS ATTENTION' : 'IN PROGRESS';
  const tone: Tone = status === 'approved' ? 'good' : status === 'rejected' || status === 'failed' ? 'bad' : status === 'paused' ? 'warn' : 'info';
  const title = state.plan?.missionName ?? state.feature;
  const quote = decision && (status === 'approved' || status === 'rejected') ? `<p class="hal">${avatar('gate', names, 'sm')}<span>${esc(decision.verdict)}</span></p>` : '';
  const error = state.error ? `<p class="callout callout-${tone}">${esc(state.error)}</p>` : '';
  return `<header class="hero">
    <div class="hero-main">
      <p class="eyebrow">Mission report · ${esc(state.id)}</p>
      <h1>${esc(title)}</h1>
      <p class="request">${rich(state.feature)}</p>
      ${quote}${error}
    </div>
    <div class="verdict verdict-${tone}" role="status"><span class="verdict-icon" aria-hidden="true">${STATUS_ICON[tone]}</span><span>${label}</span></div>
  </header>`;
}

function tiles(state: RunState): string {
  const end = state.finishedAt ?? state.updatedAt;
  const duration = new Date(end).getTime() - new Date(state.createdAt).getTime();
  const files = state.diffStat?.files.length ?? state.implementation?.filesChanged.length ?? 0;
  const tests = state.implementation?.testsAdded.length ?? 0;
  const bugs = new Set(state.qaRounds.flatMap((r) => r.bugIds));
  const open = new Set(state.qa?.bugs.map((b) => b.id) ?? []);
  const fixed = [...bugs].filter((b) => !open.has(b)).length;
  const team = 1 + (['pm', 'architect', 'qa', 'security', 'reviewer'] as const).filter((r) => state.lineup[r] !== 'off').length + (state.calls.some((c) => c.role === 'bugFixer') ? 1 : 0);
  const tile = (label: string, value: string, note = '') =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${note ? `<div class="tile-note">${esc(note)}</div>` : ''}</div>`;
  return `<div class="tiles">
    ${tile('Duration', fmtDuration(duration))}
    ${tile('AI cost', money(state.costUsd), state.budgetUsd ? `of ${money(state.budgetUsd)} budget` : 'no budget limit')}
    ${tile('Team', String(team), state.plan ? `size ${state.plan.size} · risk ${state.plan.risk}` : '')}
    ${tile('Fix rounds', String(state.iteration), `limit ${state.maxIterations}`)}
    ${tile('Files changed', String(files), state.diffStat?.measured ? `${state.diffStat.changedLines} lines` : '')}
    ${tile('Tests added', String(tests))}
    ${tile('Bugs found', String(bugs.size), bugs.size ? `${fixed} fixed` : '')}
  </div>`;
}

function debriefSection(state: RunState, names: TeamNames): string {
  const d = state.debrief;
  if (!d) return '';
  const col = (title: string, items: string[]) => (items.length ? `<div><h3>${esc(title)}</h3>${list(items)}</div>` : '');
  return section(
    'debrief',
    `Debrief from ${nameOf('lead', names)}`,
    `<div class="debrief">${avatar('lead', names, 'lg')}<div><p class="headline">${rich(d.headline)}</p><p>${rich(d.summary)}</p></div></div>
    <div class="grid-2">${col('What was built', d.whatWasBuilt)}${col('Decisions you should know about', d.decisions)}${col('Evidence', d.evidence)}${col('Risks and follow-ups', d.risks)}${col('How to try it', d.howToTry)}</div>`,
  );
}

function gateSection(decision: ReleaseDecision | undefined, names: TeamNames): string {
  if (!decision) return '';
  const rows = decision.lines
    .map((l) => `<tr><td>${esc(l.label)}</td><td>${chip(l.status, gateTone(l.status))}</td><td class="muted">${rich(l.detail ?? '')}</td></tr>`)
    .join('');
  return section(
    'gate',
    `Release gate — ${nameOf('gate', names)}`,
    `<table class="table"><thead><tr><th>Gate</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`,
    'Plain code, not an AI: every staffed stage must pass against the latest code.',
  );
}

function teamSection(state: RunState, names: TeamNames): string {
  const cards = ROSTER_ORDER.map((role) => {
    const m = MEMBERS[role];
    const calls = role === 'gate' ? [] : state.calls.filter((c) => c.role === role);
    const ms = calls.reduce((s, c) => s + c.ms, 0);
    const cost = calls.reduce((s, c) => s + c.costUsd, 0);
    let status: string;
    let tone: Tone;
    if (role === 'lead') {
      status = state.mode === 'auto' ? 'led the mission' : `${state.mode} mode`;
      tone = 'info';
    } else if (role === 'developer') {
      status = 'on the mission';
      tone = 'info';
    } else if (role === 'bugFixer') {
      status = calls.length ? 'called in' : 'on call — not needed';
      tone = calls.length ? 'info' : 'neutral';
    } else if (role === 'gate') {
      status = state.status === 'approved' ? 'approved' : state.status === 'rejected' ? 'rejected' : 'waiting';
      tone = state.status === 'approved' ? 'good' : state.status === 'rejected' ? 'bad' : 'neutral';
    } else {
      const depth = state.lineup[role as 'pm' | 'architect' | 'qa' | 'security' | 'reviewer'];
      const raised = state.upgrades.find((u) => u.member === role);
      status = depth === 'off' ? 'not needed' : `${depth}${raised ? ' · added by guardrail' : ''}`;
      tone = depth === 'off' ? 'neutral' : raised ? 'warn' : 'info';
    }
    const brief = role !== 'gate' && role !== 'lead' ? state.plan?.briefs[role as Exclude<RoleId, 'lead'>] : role === 'lead' ? state.plan?.rationale : '';
    const effort = role !== 'gate' ? state.effort[role as RoleId] : undefined;
    const inactive = tone === 'neutral' && !calls.length && role !== 'gate';
    return `<article class="member${inactive ? ' member-off' : ''}">
      <div class="member-head">${avatar(role, names, 'lg')}<div><div class="member-name">${esc(nameOf(role, names))}</div><div class="muted small">${esc(m.title)} · <i>${esc(m.origin)}</i></div></div></div>
      <div class="member-status">${chip(status, tone)}${effort && !inactive ? `<span class="muted small">effort ${esc(effort)}</span>` : ''}</div>
      ${calls.length ? `<div class="member-stats"><span>${calls.length} call${calls.length > 1 ? 's' : ''}</span><span>${fmtDuration(ms)}</span><span>${money(cost)}</span></div>` : ''}
      ${brief ? `<details><summary>${role === 'lead' ? 'Why this team' : 'Brief'}</summary><p class="small">${rich(brief)}</p></details>` : `<p class="muted small tagline">${esc(m.tagline)}</p>`}
    </article>`;
  }).join('');
  const upgrades = state.upgrades.length
    ? `<div class="callout callout-warn"><strong>Guardrails added members:</strong><ul class="list">${state.upgrades.map((u) => `<li>${esc(nameOf(u.member as RoleId, names))} → ${esc(u.to)}: ${rich(u.reason)}</li>`).join('')}</ul></div>`
    : '';
  return section('team', 'The team', `<div class="members">${cards}</div>${upgrades}`, state.mode === 'auto' ? `${nameOf('lead', names)} sized the mission and picked who works on it.` : '');
}

function timelineSection(state: RunState, names: TeamNames): string {
  if (!state.calls.length) return '';
  const t0 = new Date(state.createdAt).getTime();
  const ends = state.calls.map((c) => new Date(c.startedAt).getTime() + c.ms);
  const t1 = Math.max(...ends, new Date(state.finishedAt ?? state.updatedAt).getTime());
  const span = Math.max(1, t1 - t0);
  const roles = ROSTER_ORDER.filter((r) => r !== 'gate' && state.calls.some((c) => c.role === r)) as RoleId[];
  const rows = roles
    .map((role) => {
      const m = MEMBERS[role];
      const bars = state.calls
        .filter((c) => c.role === role)
        .map((c) => {
          const left = ((new Date(c.startedAt).getTime() - t0) / span) * 100;
          const width = Math.max((c.ms / span) * 100, 0.8);
          const tip = `${nameOf(role, names)} · ${c.step}\n${fmtDuration(c.ms)} · ${money(c.costUsd)}${c.effort ? ` · effort ${c.effort}` : ''}${c.ok ? '' : '\nfailed'}`;
          return `<span class="bar${c.ok ? '' : ' bar-failed'}" tabindex="0" data-tip="${esc(tip)}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;--m:${m.hex};--m-dark:${m.hexDark}"></span>`;
        })
        .join('');
      return `<div class="tl-row"><div class="tl-label">${avatar(role, names, 'sm')}<span>${esc(nameOf(role, names))}</span></div><div class="tl-track">${bars}</div></div>`;
    })
    .join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span style="left:${f * 100}%">${fmtDuration(span * f)}</span>`).join('');
  return section('timeline', 'Mission timeline', `<div class="timeline">${rows}<div class="tl-row tl-axis"><div></div><div class="tl-ticks">${ticks}</div></div></div>`, 'Who worked when. Hover a bar for details.');
}

function flowSection(state: RunState, names: TeamNames): string {
  const label: Record<string, [Actor, string]> = {
    baseline: ['system', 'Baseline checks'],
    plan: ['lead', 'Plan'],
    pm: ['pm', 'Spec'],
    clarify: ['human', 'Clarify'],
    design: ['architect', 'Design'],
    develop: ['developer', 'Build'],
    checks: ['system', 'Checks'],
    qa: ['qa', 'Test'],
    fix: ['bugFixer', 'Fix'],
    arbitrate: ['lead', 'Ruling'],
    review: ['reviewer', 'Review'],
    rework: ['developer', 'Rework'],
    release: ['gate', 'Gate'],
    debrief: ['lead', 'Debrief'],
  };
  const steps = state.events.filter((e) => e.kind === 'start' && e.text.startsWith('step:')).map((e) => e.text.slice(5));
  if (!steps.length) return '';
  const chips = steps
    .map((s) => {
      const [actor, text] = label[s] ?? ['system', s];
      const who = actor === 'system' || actor === 'human' ? '' : ` · ${esc(nameOf(actor as RoleId | 'gate', names))}`;
      return `<li class="flow-step">${avatar(actor, names, 'sm')}<span>${esc(text)}<span class="muted small">${who}</span></span></li>`;
    })
    .join('<li class="flow-arrow" aria-hidden="true">→</li>');
  return section('flow', 'How the mission went', `<ol class="flow">${chips}</ol>`);
}

function traceSection(state: RunState): string {
  const spec = state.spec;
  if (!spec) return '';
  const rows = spec.acceptanceCriteria
    .map((ac) => {
      const cov = state.implementation?.criteriaCoverage.find((c) => c.id === ac.id);
      const qa = state.qa?.criteria.find((c) => c.id === ac.id);
      return `<tr>
        <td><strong>${esc(ac.id)}</strong></td>
        <td>${rich(ac.criterion)}</td>
        <td>${cov ? chip(cov.status, resultTone(cov.status)) : chip('—', 'neutral')}</td>
        <td class="small">${cov?.tests.length ? cov.tests.map((t) => `<code>${esc(t)}</code>`).join(' ') : '<span class="muted">—</span>'}</td>
        <td>${qa ? chip(qa.result, resultTone(qa.result), qa.evidence) : chip(state.lineup.qa === 'off' ? 'not staffed' : '—', 'neutral')}</td>
        <td class="small muted">${rich(qa?.evidence ?? '')}</td>
      </tr>`;
    })
    .join('');
  const edge = spec.edgeCases.length
    ? `<details><summary>${spec.edgeCases.length} edge cases</summary><ul class="list">${spec.edgeCases.map((e) => `<li><strong>${esc(e.id)}</strong> ${rich(e.case)} → <i>${rich(e.expected)}</i></li>`).join('')}</ul></details>`
    : '';
  return section(
    'trace',
    'Requirements traceability',
    `<div class="scroll"><table class="table"><thead><tr><th>ID</th><th>Acceptance criterion</th><th>Built</th><th>Tests</th><th>QA</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>${edge}`,
    'Every acceptance criterion, traced from spec to code, tests and QA evidence.',
  );
}

function qaSection(state: RunState, names: TeamNames): string {
  const qa = state.qa;
  if (!qa) return '';
  const cats = new Map<string, { pass: number; fail: number; nt: number }>();
  for (const s of qa.scenarios) {
    const c = cats.get(s.category) ?? { pass: 0, fail: 0, nt: 0 };
    if (s.result === 'PASS') c.pass++;
    else if (s.result === 'FAIL') c.fail++;
    else c.nt++;
    cats.set(s.category, c);
  }
  const max = Math.max(1, ...[...cats.values()].map((c) => c.pass + c.fail + c.nt));
  const bars = [...cats.entries()]
    .sort((a, b) => b[1].pass + b[1].fail + b[1].nt - (a[1].pass + a[1].fail + a[1].nt))
    .map(([cat, c]) => {
      const seg = (n: number, cls: string, what: string) =>
        n ? `<span class="seg ${cls}" tabindex="0" style="flex:${n}" data-tip="${esc(`${n} ${what}\n${cat}`)}"></span>` : '';
      const total = c.pass + c.fail + c.nt;
      return `<div class="hbar-row"><div class="hbar-label">${esc(cat)}</div><div class="hbar-track"><div class="hbar-stack" style="width:${((total / max) * 100).toFixed(1)}%">${seg(c.pass, 'seg-good', 'passed')}${seg(c.fail, 'seg-bad', 'failed')}${seg(c.nt, 'seg-neutral', 'not testable')}</div><span class="hbar-value">${total}</span></div></div>`;
    })
    .join('');
  const legend = `<div class="legend"><span><i class="key key-good"></i>✓ Passed</span><span><i class="key key-bad"></i>✗ Failed</span><span><i class="key key-neutral"></i>– Not testable</span></div>`;

  // Bug journeys across rounds
  const allBugs = new Map<string, { title: string; severity: Severity; location: string }>();
  for (const r of state.qaRounds) {
    for (const b of r.bugs ?? []) allBugs.set(b.id, { title: b.title, severity: b.severity, location: '' });
    for (const id of r.bugIds) if (!allBugs.has(id)) allBugs.set(id, { title: id, severity: 'MEDIUM', location: '' });
  }
  const latest = new Set(qa.bugs.map((b) => b.id));
  for (const b of qa.bugs) allBugs.set(b.id, { title: b.title, severity: b.severity, location: b.location });
  const journeys = [...allBugs.entries()]
    .map(([id, info]) => {
      const found = state.qaRounds.find((r) => r.bugIds.includes(id))?.round;
      const fixes = state.fixes.flatMap((f) => f.fixes.filter((x) => x.id === id).map((x) => ({ round: f.round, status: x.status, cause: x.rootCause, by: f.by })));
      const waiver = state.waivers.find((w) => w.id === id);
      const lastRound = state.qaRounds.at(-1)?.round;
      const verified = !latest.has(id) && lastRound !== undefined && lastRound !== found;
      const steps = [
        `<li>${avatar('qa', names, 'sm')}<span>Found in QA round ${found ?? '?'}</span></li>`,
        ...fixes.map((f) => `<li>${avatar(f.by, names, 'sm')}<span>${esc(f.status === 'FIXED' ? 'Fixed' : f.status === 'NOT_A_BUG' ? 'Disputed (not a bug)' : 'Could not fix')} in round ${f.round}${f.cause ? ` — <i>${rich(f.cause)}</i>` : ''}</span></li>`),
        waiver ? `<li>${avatar(waiver.by === 'human' ? 'human' : 'lead', names, 'sm')}<span>Waived: ${rich(waiver.reason)}</span></li>` : '',
        verified ? `<li>${avatar('qa', names, 'sm')}<span>Verified fixed in round ${lastRound}</span></li>` : latest.has(id) && !waiver ? `<li>${chip('still open', 'bad')}</li>` : '',
      ].join('');
      const tone: Tone = waiver ? 'warn' : latest.has(id) ? 'bad' : 'good';
      return `<article class="journey journey-${tone}"><header><strong>${esc(id)}</strong> ${chip(info.severity, sevTone(info.severity))}<span>${rich(info.title)}</span></header><ol class="journey-steps">${steps}</ol></article>`;
    })
    .join('');

  return section(
    'qa',
    `QA — ${nameOf('qa', names)}`,
    `<p>${chip(`QA ${qa.status}`, resultTone(qa.status))} <span class="muted">${state.qaRounds.length} round(s) · ${qa.scenarios.length} scenarios in the latest round</span></p>
    <p>${rich(qa.summary)}</p>
    ${cats.size ? `<h3>Latest round by category</h3>${legend}<div class="hbars">${bars}</div>` : ''}
    ${journeys ? `<h3>Bug journeys</h3><div class="journeys">${journeys}</div>` : ''}
    <details><summary>All ${qa.scenarios.length} scenarios</summary><div class="scroll"><table class="table"><thead><tr><th>Category</th><th>Scenario</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${qa.scenarios
      .map((s) => `<tr><td>${esc(s.category)}</td><td>${rich(s.scenario)}</td><td>${chip(s.result, resultTone(s.result))}</td><td class="small muted">${rich(s.evidence)}</td></tr>`)
      .join('')}</tbody></table></div></details>`,
  );
}

function reviewSection(state: RunState, which: 'security' | 'reviewer', names: TeamNames): string {
  const review = which === 'security' ? state.security : state.review;
  if (!review) return '';
  const waived = new Set(state.waivers.map((w) => w.id));
  const findings = review.findings.length
    ? `<div class="scroll"><table class="table"><thead><tr><th>ID</th><th>Severity</th><th>Issue</th><th>Where</th><th>Suggestion</th></tr></thead><tbody>${review.findings
        .map(
          (f) =>
            `<tr><td><strong>${esc(f.id)}</strong>${waived.has(f.id) ? ` ${chip('waived', 'warn')}` : ''}</td><td>${chip(f.severity, sevTone(f.severity))}</td><td>${rich(f.description)}<div class="muted small">${esc(f.category)}${f.standard ? ` · ${esc(f.standard)}` : ''}</div></td><td class="small"><code>${esc(f.file)}</code></td><td class="small">${rich(f.suggestion)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="muted">No findings.</p>';
  const threats = review.threats.length
    ? `<details><summary>Threat model (STRIDE) — ${review.threats.length} threats</summary><table class="table"><thead><tr><th>Category</th><th>Threat</th><th>Mitigated</th></tr></thead><tbody>${review.threats
        .map((t) => `<tr><td>${esc(t.category)}</td><td>${rich(t.threat)}</td><td>${chip(t.mitigated ? 'yes' : 'no', t.mitigated ? 'good' : 'bad')}</td></tr>`)
        .join('')}</tbody></table></details>`
    : '';
  const praise = review.praise.length ? `<h3>Done well</h3>${list(review.praise)}` : '';
  const role = which === 'security' ? 'security' : 'reviewer';
  return section(
    which,
    `${which === 'security' ? 'Security' : 'Code review'} — ${nameOf(role, names)}`,
    `<p>${chip(review.status, resultTone(review.status))} ${chip(`code health: ${review.codeHealth}`, review.codeHealth === 'degrades' ? 'bad' : review.codeHealth === 'improves' ? 'good' : 'neutral')} <span class="muted">reviewed code revision ${review.codeVersion}</span></p>
    <p>${rich(review.summary)}</p>${findings}${threats}${praise}${review.missedEdgeCases.length ? `<h3>Edge cases nobody considered</h3>${list(review.missedEdgeCases)}` : ''}`,
  );
}

function scansSection(state: RunState): string {
  if (!state.scans.length) return '';
  return section(
    'scans',
    'Automated scan leads',
    `<table class="table"><thead><tr><th>Rule</th><th>Severity hint</th><th>File</th><th>Line</th></tr></thead><tbody>${state.scans
      .map((s) => `<tr><td>${esc(s.title)}<div class="muted small">${esc(s.standard)}</div></td><td>${chip(s.severity, sevTone(s.severity))}</td><td class="small"><code>${esc(s.file)}</code></td><td class="small"><code>${esc(s.snippet)}</code></td></tr>`)
      .join('')}</tbody></table>`,
    'Pattern matches in the added lines. Reviewers verified each one; they can be false positives.',
  );
}

function checksSection(state: RunState): string {
  const latest = state.checks?.results ?? [];
  const base = state.baseline?.results ?? [];
  if (!latest.length && !base.length) return '';
  const names = [...new Set([...base.map((r) => r.name), ...latest.map((r) => r.name)])];
  const rows = names
    .map((n) => {
      const b = base.find((r) => r.name === n);
      const l = latest.find((r) => r.name === n);
      const cell = (r?: { passed: boolean; durationMs: number }) => (r ? `${chip(r.passed ? 'pass' : 'fail', r.passed ? 'good' : 'bad')} <span class="muted small">${(r.durationMs / 1000).toFixed(1)}s</span>` : '<span class="muted">—</span>');
      return `<tr><td>${esc(n)}</td><td><code>${esc(l?.command ?? b?.command ?? '')}</code></td><td>${cell(b)}</td><td>${cell(l)}</td></tr>`;
    })
    .join('');
  return section('checks', 'Checks', `<table class="table"><thead><tr><th>Check</th><th>Command</th><th>Before the mission</th><th>Latest code</th></tr></thead><tbody>${rows}</tbody></table>`, 'Run by the orchestrator itself — agents can’t fake these.');
}

function changesSection(state: RunState): string {
  const files = state.diffStat?.files ?? [];
  if (!files.length || !state.diffStat?.measured) return '';
  const max = Math.max(1, ...files.map((f) => f.added + f.deleted));
  const rows = files
    .map(
      (f) => `<div class="diff-row"><code class="diff-file">${esc(f.path)}</code><span class="diff-num"><span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span></span><span class="diff-bar" tabindex="0" data-tip="${esc(`${f.path}\n+${f.added} added · −${f.deleted} removed`)}"><span class="diff-add" style="width:${((f.added / max) * 100).toFixed(1)}%"></span><span class="diff-del" style="width:${((f.deleted / max) * 100).toFixed(1)}%"></span></span></div>`,
    )
    .join('');
  return section('changes', 'What changed', `<div class="legend"><span><i class="key key-add"></i>Added lines</span><span><i class="key key-del"></i>Removed lines</span></div><div class="diff">${rows}</div>`, `${files.length} file(s), ${state.diffStat?.changedLines ?? 0} lines, since the mission started.`);
}

function warRoomSection(state: RunState, names: TeamNames): string {
  const events = state.events.filter((e) => !(e.kind === 'start' && e.text.startsWith('step:')));
  if (!events.length) return '';
  const kindTone: Partial<Record<TeamEvent['kind'], Tone>> = { guardrail: 'warn', warning: 'warn', fail: 'bad', decision: 'info', question: 'info', answer: 'info' };
  const items = events
    .map((e) => {
      const to = e.to ? ` <span class="muted">→ ${esc(actorName(e.to, names))}</span>` : '';
      const tone = kindTone[e.kind];
      return `<li class="msg${e.from === 'human' ? ' msg-human' : ''}">${avatar(e.from, names)}<div class="bubble${tone ? ` bubble-${tone}` : ''}"><div class="msg-head"><strong>${esc(actorName(e.from, names))}</strong>${to}<span class="muted small">${esc(time(e.at))}</span></div><div>${rich(e.text)}</div></div></li>`;
    })
    .join('');
  return section('warroom', 'War room', `<ol class="chat">${items}</ol>`, 'Every handoff, decision and guardrail, as it happened.');
}

function costSection(state: RunState, names: TeamNames): string {
  if (!state.calls.length) return '';
  const roles = ROSTER_ORDER.filter((r) => r !== 'gate' && state.calls.some((c) => c.role === r)) as RoleId[];
  const totals = roles.map((r) => {
    const calls = state.calls.filter((c) => c.role === r);
    return { role: r, cost: calls.reduce((s, c) => s + c.costUsd, 0), ms: calls.reduce((s, c) => s + c.ms, 0) };
  });
  const chart = (title: string, values: Array<{ role: RoleId; v: number; label: string }>) => {
    const max = Math.max(1e-9, ...values.map((x) => x.v));
    return `<div><h3>${esc(title)}</h3><div class="hbars">${values
      .map(
        (x) =>
          `<div class="hbar-row"><div class="hbar-label">${esc(nameOf(x.role, names))}</div><div class="hbar-track"><span class="hbar-single" tabindex="0" data-tip="${esc(`${nameOf(x.role, names)}\n${x.label}`)}" style="width:${((x.v / max) * 100).toFixed(1)}%"></span><span class="hbar-value">${esc(x.label)}</span></div></div>`,
      )
      .join('')}</div></div>`;
  };
  return section(
    'cost',
    'Where the time and money went',
    `<div class="grid-2">${chart('AI cost by member', totals.map((t) => ({ role: t.role, v: t.cost, label: money(t.cost) })))}${chart('Working time by member', totals.map((t) => ({ role: t.role, v: t.ms, label: fmtDuration(t.ms) })))}</div>`,
  );
}

function rulesSection(state: RunState, names: TeamNames): string {
  if (!state.ruleUpdates.length) return '';
  return section(
    'rules',
    'Rulebook updates',
    `<ul class="list">${state.ruleUpdates.map((u) => `<li>${chip(u.action, u.action === 'remove' ? 'neutral' : 'info')} <strong>${esc(u.id)}</strong> ${rich(u.rule)}<div class="muted small">${rich(u.reason)}</div></li>`).join('')}</ul>`,
    `${nameOf('lead', names)} updated the team's rulebook (.ai-team/rules.md) after this mission.`,
  );
}

function designSection(state: RunState, names: TeamNames): string {
  const d = state.design;
  if (!d) return '';
  const diagrams = [d.sequenceDiagram, d.erDiagram].map((s) => mermaidSource(s)).filter(Boolean);
  return section(
    'design',
    `Design — ${nameOf('architect', names)}`,
    `<p>${rich(d.approach)}</p>
    ${diagrams.map((src) => `<pre class="mermaid">${esc(src)}</pre>`).join('')}
    ${d.decisions.length ? `<h3>Decisions</h3><ul class="list">${d.decisions.map((a) => `<li><strong>${esc(a.id)} ${esc(a.title)}</strong> — ${rich(a.decision)}</li>`).join('')}</ul>` : ''}
    ${d.filePlan.length ? `<details><summary>File plan (${d.filePlan.length})</summary><ul class="list">${d.filePlan.map((f) => `<li><code>${esc(f.path)}</code> <span class="muted">${esc(f.action)}</span> — ${rich(f.purpose)}</li>`).join('')}</ul></details>` : ''}`,
  );
}

function artifactsSection(state: RunState): string {
  if (!state.artifacts.length) return '';
  return section('artifacts', 'Artifacts', `<ul class="files">${state.artifacts.map((a) => `<li><a href="${esc(encodeURI(a.file))}">${esc(a.file)}</a></li>`).join('')}</ul>`);
}

// ── Page ──────────────────────────────────────────────────────────────────

export function renderReport(state: RunState, opts: ReportOptions): string {
  const { names } = opts;
  const finished = state.status === 'approved' || state.status === 'rejected';
  const decision = finished || state.status !== 'running' ? evaluateRelease(state, opts) : undefined;
  const hasMermaid = !!state.design && !!(state.design.sequenceDiagram.trim() || state.design.erDiagram.trim());
  const nav = [
    ['debrief', 'Debrief'],
    ['team', 'Team'],
    ['timeline', 'Timeline'],
    ['trace', 'Requirements'],
    ['qa', 'QA'],
    ['security', 'Security'],
    ['reviewer', 'Review'],
    ['changes', 'Changes'],
    ['warroom', 'War room'],
  ];
  const body = [
    hero(state, decision, names),
    tiles(state),
    debriefSection(state, names),
    gateSection(decision, names),
    teamSection(state, names),
    flowSection(state, names),
    timelineSection(state, names),
    traceSection(state),
    designSection(state, names),
    qaSection(state, names),
    reviewSection(state, 'security', names),
    reviewSection(state, 'reviewer', names),
    scansSection(state),
    checksSection(state),
    changesSection(state),
    costSection(state, names),
    rulesSection(state, names),
    warRoomSection(state, names),
    artifactsSection(state),
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(state.plan?.missionName ?? 'Mission report')} — AI Team</title>
${finished ? '' : '<meta http-equiv="refresh" content="15">'}
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <nav class="topbar"><span class="brand">${avatar('lead', names, 'sm')} AI Engineering Team</span><span class="nav">${nav.map(([id, l]) => `<a href="#${id}">${l}</a>`).join('')}</span><button class="theme" type="button" aria-label="Toggle light or dark theme">◐</button></nav>
  ${body}
  <footer class="muted small">Generated by ai-engineering-team ${esc(version())} · ${esc(new Date(state.updatedAt).toLocaleString())}${finished ? '' : ' · refreshes every 15s while the mission runs'}</footer>
</div>
<div class="tooltip" role="tooltip" hidden></div>
<script>${JS}</script>
${hasMermaid ? `<script type="module">try{const{default:m}=await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');const dark=document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);m.initialize({startOnLoad:false,theme:dark?'dark':'neutral',securityLevel:'strict'});await m.run({querySelector:'pre.mermaid'});}catch(e){}</script>` : ''}
</body>
</html>`;
}

const CSS = `
:root{color-scheme:light;
--page:#f9f9f7;--surface:#fcfcfb;--surface-2:#f3f2ee;--ink:#0b0b0b;--ink-2:#52514e;--muted:#6f6d68;--line:#e1e0d9;--ring:rgba(11,11,11,.10);
--good:#0ca30c;--good-ink:#006300;--bad:#d03b3b;--warn:#fab219;--serious:#ec835a;--neutral:#898781;--info:#2a78d6;--add:#2a78d6;--del:#e34948;--bar:#2a78d6;
--good-bg:rgba(12,163,12,.10);--bad-bg:rgba(208,59,59,.10);--warn-bg:rgba(250,178,25,.16);--info-bg:rgba(42,120,214,.10);--neutral-bg:rgba(137,135,129,.12)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;
--page:#0d0d0d;--surface:#1a1a19;--surface-2:#232321;--ink:#ffffff;--ink-2:#c3c2b7;--muted:#a3a198;--line:#2c2c2a;--ring:rgba(255,255,255,.10);
--good-ink:#0ca30c;--info:#3987e5;--add:#3987e5;--del:#e66767;--bar:#3987e5;
--good-bg:rgba(12,163,12,.18);--bad-bg:rgba(208,59,59,.20);--warn-bg:rgba(250,178,25,.16);--info-bg:rgba(57,135,229,.18);--neutral-bg:rgba(137,135,129,.18)}}
:root[data-theme="dark"]{color-scheme:dark;
--page:#0d0d0d;--surface:#1a1a19;--surface-2:#232321;--ink:#ffffff;--ink-2:#c3c2b7;--muted:#a3a198;--line:#2c2c2a;--ring:rgba(255,255,255,.10);
--good-ink:#0ca30c;--info:#3987e5;--add:#3987e5;--del:#e66767;--bar:#3987e5;
--good-bg:rgba(12,163,12,.18);--bad-bg:rgba(208,59,59,.20);--warn-bg:rgba(250,178,25,.16);--info-bg:rgba(57,135,229,.18);--neutral-bg:rgba(137,135,129,.18)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.page{max-width:1180px;margin:0 auto;padding:0 16px 48px}
a{color:var(--info)}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--surface-2);padding:1px 5px;border-radius:5px;word-break:break-word}
h1{font-size:30px;line-height:1.2;margin:6px 0 8px;letter-spacing:-.01em}
h2{font-size:18px;margin:0}
h3{font-size:14px;margin:18px 0 8px;color:var(--ink-2)}
.muted{color:var(--muted)} .small{font-size:13px}
.topbar{position:sticky;top:0;z-index:5;display:flex;gap:16px;align-items:center;padding:10px 0;background:var(--page);border-bottom:1px solid var(--line);margin-bottom:20px}
.brand{display:flex;gap:8px;align-items:center;font-weight:600;white-space:nowrap}
.nav{display:flex;gap:14px;overflow-x:auto;flex:1;scrollbar-width:none}.nav a{color:var(--ink-2);text-decoration:none;font-size:13px;white-space:nowrap}.nav a:hover{color:var(--ink)}
.theme{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;width:34px;height:30px;cursor:pointer;font-size:15px}
.hero{display:flex;gap:24px;align-items:flex-start;justify-content:space-between;background:var(--surface);border:1px solid var(--ring);border-radius:16px;padding:24px;margin-bottom:16px}
.eyebrow{margin:0;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.request{margin:0;color:var(--ink-2);max-width:760px}
.hal{display:flex;gap:10px;align-items:center;margin:14px 0 0;font-style:italic;color:var(--ink-2)}
.verdict{display:flex;gap:10px;align-items:center;font-weight:700;font-size:20px;padding:14px 20px;border-radius:14px;white-space:nowrap;border:1px solid var(--ring)}
.verdict-good{background:var(--good-bg)} .verdict-bad{background:var(--bad-bg)} .verdict-warn{background:var(--warn-bg)} .verdict-info{background:var(--info-bg)}
.verdict-icon{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;color:#fff;font-size:16px}
.verdict-good .verdict-icon{background:var(--good)} .verdict-bad .verdict-icon{background:var(--bad)} .verdict-warn .verdict-icon{background:var(--warn);color:#0b0b0b} .verdict-info .verdict-icon{background:var(--info)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:14px;padding:14px 16px}
.tile-label{font-size:12.5px;color:var(--muted)} .tile-value{font-size:26px;font-weight:650;margin-top:2px} .tile-note{font-size:12px;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:16px;padding:20px 22px;margin-bottom:16px}
.card-head{margin-bottom:12px}.card-head p{margin:4px 0 0;font-size:13px}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px 28px}
.list{margin:0;padding-left:18px}.list li{margin:4px 0}
.callout{border-radius:12px;padding:10px 14px;margin:12px 0 0;border:1px solid var(--ring)}
.callout-warn{background:var(--warn-bg)} .callout-bad{background:var(--bad-bg)} .callout-info{background:var(--info-bg)} .callout-good{background:var(--good-bg)}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px 2px 4px;border-radius:999px;font-size:12.5px;font-weight:550;background:var(--neutral-bg);color:var(--ink);white-space:nowrap;vertical-align:middle}
.chip-dot{display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;font-size:10.5px;color:#fff;background:var(--neutral)}
.chip-good{background:var(--good-bg)}.chip-good .chip-dot{background:var(--good)}
.chip-bad{background:var(--bad-bg)}.chip-bad .chip-dot{background:var(--bad)}
.chip-warn{background:var(--warn-bg)}.chip-warn .chip-dot{background:var(--warn);color:#0b0b0b}
.chip-info{background:var(--info-bg)}.chip-info .chip-dot{background:var(--info)}
.avatar{--c:var(--m,#898781);display:inline-grid;place-items:center;border-radius:50%;flex:none;background:color-mix(in srgb,var(--c) 18%,var(--surface));box-shadow:inset 0 0 0 2px var(--c)}
:root[data-theme="dark"] .avatar{--c:var(--m-dark,var(--m,#898781))}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .avatar{--c:var(--m-dark,var(--m,#898781))}}
.avatar-plain{--c:#898781}
.avatar-sm{width:24px;height:24px;font-size:13px}.avatar-md{width:32px;height:32px;font-size:17px}.avatar-lg{width:44px;height:44px;font-size:22px}
.members{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.member{border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--surface)}
.member-off{opacity:.6}
.member-head{display:flex;gap:12px;align-items:center}.member-name{font-weight:700;letter-spacing:.02em}
.member-status{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.member-stats{display:flex;gap:14px;font-size:13px;color:var(--ink-2)}
.member details{font-size:13px}.member summary{cursor:pointer;color:var(--ink-2)}
.tagline{margin:0}
.flow{list-style:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:0;margin:0}
.flow-step{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:3px 12px 3px 4px;background:var(--surface-2);font-size:13px}
.flow-arrow{color:var(--muted)}
.timeline{display:flex;flex-direction:column;gap:6px}
.tl-row{display:grid;grid-template-columns:150px 1fr;gap:12px;align-items:center}
.tl-label{display:flex;gap:8px;align-items:center;font-size:13px;font-weight:600}
.tl-track{position:relative;height:22px;background:var(--surface-2);border-radius:6px}
.bar{position:absolute;top:4px;height:14px;border-radius:4px;background:var(--m);cursor:default;outline-offset:2px}
:root[data-theme="dark"] .bar{background:var(--m-dark)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .bar{background:var(--m-dark)}}
.bar:hover,.bar:focus{filter:brightness(1.12);box-shadow:0 0 0 2px var(--surface),0 0 0 3px var(--ink-2)}
.bar-failed{background:repeating-linear-gradient(45deg,var(--bad) 0 4px,transparent 4px 8px)!important;box-shadow:inset 0 0 0 1.5px var(--bad)}
.tl-axis .tl-ticks{position:relative;height:18px;border-top:1px solid var(--line)}
.tl-ticks span{position:absolute;top:2px;transform:translateX(-50%);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.tl-ticks span:first-child{transform:none}.tl-ticks span:last-child{transform:translateX(-100%)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--ink-2);margin:6px 0 10px}
.legend span{display:flex;align-items:center;gap:6px}
.key{display:inline-block;width:12px;height:12px;border-radius:3px}
.key-good{background:var(--good)}.key-bad{background:var(--bad)}.key-neutral{background:var(--neutral)}.key-add{background:var(--add)}.key-del{background:var(--del)}
.hbars{display:flex;flex-direction:column;gap:8px}
.hbar-row{display:grid;grid-template-columns:minmax(110px,180px) 1fr;gap:12px;align-items:center}
.hbar-label{font-size:13px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbar-track{display:flex;align-items:center;gap:8px;min-width:0}
.hbar-stack{display:flex;gap:2px;height:14px;min-width:6px}
.seg{height:100%;min-width:4px}
.seg:first-child{border-radius:0}.seg:last-child{border-radius:0 4px 4px 0}
.seg-good{background:var(--good)}.seg-bad{background:var(--bad)}.seg-neutral{background:var(--neutral)}
.seg:hover,.seg:focus,.hbar-single:hover,.hbar-single:focus{filter:brightness(1.12);outline:none;box-shadow:0 0 0 2px var(--surface),0 0 0 3px var(--ink-2)}
.hbar-single{display:block;height:14px;min-width:4px;border-radius:0 4px 4px 0;background:var(--bar)}
.hbar-value{font-size:12.5px;color:var(--ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.journeys{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.journey{border:1px solid var(--line);border-left-width:4px;border-radius:12px;padding:12px 14px}
.journey-good{border-left-color:var(--good)}.journey-bad{border-left-color:var(--bad)}.journey-warn{border-left-color:var(--warn)}
.journey header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px}
.journey-steps{list-style:none;padding:0;margin:10px 0 0;display:flex;flex-direction:column;gap:6px;font-size:13px}
.journey-steps li{display:flex;gap:8px;align-items:center}
.table{width:100%;border-collapse:collapse;font-size:13.5px}
.table th{text-align:left;font-weight:600;color:var(--ink-2);border-bottom:1px solid var(--line);padding:8px 10px;white-space:nowrap}
.table td{border-bottom:1px solid var(--line);padding:8px 10px;vertical-align:top}
.table tr:last-child td{border-bottom:0}
.scroll{overflow-x:auto}
details{margin-top:12px}summary{cursor:pointer;color:var(--ink-2);font-size:13.5px}
.diff{display:flex;flex-direction:column;gap:6px}
.diff-row{display:grid;grid-template-columns:minmax(0,1fr) 90px 180px;gap:12px;align-items:center}
.diff-file{background:none;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.diff-num{font-size:12.5px;font-variant-numeric:tabular-nums;text-align:right;color:var(--ink-2)}
.diff-bar{display:flex;gap:2px;height:10px}
.diff-add{background:var(--add);border-radius:0}.diff-del{background:var(--del);border-radius:0 4px 4px 0}
.chat{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px;max-height:640px;overflow-y:auto}
.msg{display:flex;gap:10px;align-items:flex-start}
.msg-human{flex-direction:row-reverse}
.bubble{background:var(--surface-2);border:1px solid var(--line);border-radius:4px 14px 14px 14px;padding:8px 12px;max-width:780px;font-size:13.5px}
.msg-human .bubble{border-radius:14px 4px 14px 14px}
.bubble-warn{background:var(--warn-bg)}.bubble-bad{background:var(--bad-bg)}.bubble-info{background:var(--info-bg)}
.msg-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:2px}
.debrief{display:flex;gap:14px;align-items:flex-start}.headline{font-size:17px;font-weight:650;margin:0 0 4px}
.files{columns:2;padding-left:18px;font-size:13px}
pre.mermaid{background:var(--surface-2);border-radius:12px;padding:14px;overflow-x:auto;font-size:12px}
footer{margin-top:24px;text-align:center}
.tooltip{position:fixed;z-index:20;pointer-events:none;background:var(--ink);color:var(--surface);font-size:12.5px;line-height:1.45;padding:7px 10px;border-radius:8px;max-width:280px;white-space:pre-line;box-shadow:0 6px 24px rgba(0,0,0,.18)}
.tooltip strong{display:block;font-size:13.5px}
@media (max-width:720px){.hero{flex-direction:column}.tl-row{grid-template-columns:96px 1fr}.tl-label span{overflow:hidden;text-overflow:ellipsis}.diff-row{grid-template-columns:minmax(0,1fr) 80px}.diff-bar{display:none}.files{columns:1}h1{font-size:24px}}
@media (forced-colors:active){.bar,.seg,.hbar-single,.diff-add,.diff-del{forced-color-adjust:none;border:1px solid CanvasText}}
@media print{.topbar,.theme{display:none}.card,.hero,.tile{break-inside:avoid}}
`;

const JS = `
(function(){
  var root=document.documentElement;
  try{var saved=localStorage.getItem('ai-team-theme');if(saved)root.dataset.theme=saved;}catch(e){}
  var btn=document.querySelector('.theme');
  if(btn)btn.addEventListener('click',function(){
    var dark=root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme=dark?'light':'dark';
    try{localStorage.setItem('ai-team-theme',root.dataset.theme);}catch(e){}
  });
  var tip=document.querySelector('.tooltip');
  function show(el,x,y){
    var lines=(el.getAttribute('data-tip')||'').split('\\n');
    tip.textContent='';
    var strong=document.createElement('strong');strong.textContent=lines[0];tip.appendChild(strong);
    if(lines.length>1)tip.appendChild(document.createTextNode(lines.slice(1).join('\\n')));
    tip.hidden=false;
    var r=tip.getBoundingClientRect();
    var left=Math.min(window.innerWidth-r.width-8,Math.max(8,x+12));
    var top=y-r.height-12<8?y+16:y-r.height-12;
    tip.style.left=left+'px';tip.style.top=top+'px';
  }
  function hide(){tip.hidden=true;}
  document.querySelectorAll('[data-tip]').forEach(function(el){
    el.addEventListener('pointermove',function(e){show(el,e.clientX,e.clientY);});
    el.addEventListener('pointerleave',hide);
    el.addEventListener('focus',function(){var r=el.getBoundingClientRect();show(el,r.left+r.width/2,r.top);});
    el.addEventListener('blur',hide);
  });
})();
`;
