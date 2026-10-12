#!/usr/bin/env node
// Builds a comparison table from bench/results/<label>/*.json and writes bench/RESULTS.md.
//   node bench/compare.mjs [label ...]     (default: every label that has results)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');
const labels = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(RESULTS).filter((d) => fs.statSync(path.join(RESULTS, d)).isDirectory()).sort();

const data = labels.map((label) => ({
  label,
  runs: fs
    .readdirSync(path.join(RESULTS, label))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS, label, f), 'utf8'))),
}));
const scenarios = [...new Set(data.flatMap((d) => d.runs.map((r) => r.scenario)))].sort();

const pct = (p, t) => (t ? `${Math.round((p / t) * 100)}%` : '-');
const team = (lineup) => {
  if (!lineup) return '-';
  if (typeof lineup === 'string') return lineup;
  const on = Object.entries(lineup).filter(([, v]) => v !== 'off').map(([k, v]) => `${k}${v === 'light' ? '(l)' : ''}`);
  return on.length ? `dev + ${on.join(', ')}` : 'dev solo';
};

const lines = ['# Proving Ground results', '', `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Hidden tests are never shown to the team; they check the traps described in [docs/research.md](../docs/research.md).`, ''];

const kTok = (n) => `${Math.round(n / 1000)}k`;
const tokenSum = (runs, key) => runs.reduce((s, r) => s + (r.tokens?.[key] ?? 0), 0);

lines.push('## Totals', '', '| Contender | Hidden tests passed | Visible tests | AI cost | Tokens out · cache-write · cache-read | Calls | Wall time | Missions approved |', '|---|---|---|---|---|---|---|---|');
for (const d of data) {
  const hp = d.runs.reduce((s, r) => s + r.hidden.passed, 0);
  const ht = d.runs.reduce((s, r) => s + r.hidden.total, 0);
  const vp = d.runs.reduce((s, r) => s + r.visible.passed, 0);
  const vt = d.runs.reduce((s, r) => s + r.visible.total, 0);
  const cost = d.runs.reduce((s, r) => s + r.costUsd, 0);
  const onboarding = d.runs.reduce((s, r) => s + (r.onboardingCostUsd ?? 0), 0);
  const mins = d.runs.reduce((s, r) => s + r.wallMinutes, 0);
  const approved = d.runs.filter((r) => r.status === 'approved' || r.status === 'done').length;
  const hasTokens = d.runs.some((r) => r.tokens);
  const tokens = hasTokens ? `${kTok(tokenSum(d.runs, 'output'))} · ${kTok(tokenSum(d.runs, 'cacheWrite'))} · ${kTok(tokenSum(d.runs, 'cacheRead'))}` : '-';
  const calls = d.runs.some((r) => r.calls) ? d.runs.reduce((s, r) => s + (r.calls?.length ?? 0), 0) : '-';
  lines.push(`| **${d.label}** | ${hp}/${ht} (${pct(hp, ht)}) | ${vp}/${vt} | $${cost.toFixed(2)}${onboarding ? ` (+$${onboarding.toFixed(2)} onboarding)` : ''} | ${tokens} | ${calls} | ${mins.toFixed(1)} min | ${approved}/${d.runs.length} |`);
}

for (const scenario of scenarios) {
  lines.push('', `## ${scenario}`, '', '| Contender | Hidden | Status | Cost | Time | Rounds | Team | Hidden failures |', '|---|---|---|---|---|---|---|---|');
  for (const d of data) {
    const r = d.runs.find((x) => x.scenario === scenario);
    if (!r) continue;
    lines.push(
      `| ${d.label} | ${r.hidden.passed}/${r.hidden.total} | ${r.status} | $${r.costUsd.toFixed(2)} | ${r.wallMinutes} min | ${r.iterations ?? '-'} | ${team(r.lineup)} | ${r.hidden.failures.join('; ') || '—'} |`,
    );
  }
}

const out = lines.join('\n') + '\n';
fs.writeFileSync(path.join(HERE, 'RESULTS.md'), out);
console.log(out);
