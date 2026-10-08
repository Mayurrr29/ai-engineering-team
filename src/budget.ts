import fs from 'node:fs';
import { paths } from './paths.js';
import type { Depth, Lineup, MissionPlan } from './schemas.js';
import type { RoleId } from './team.js';

/** Rough starting estimates (USD per call at full depth on a medium task) until the project has its own history. */
const DEFAULT_COST: Record<RoleId, number> = {
  lead: 0.1,
  pm: 0.3,
  architect: 0.35,
  developer: 0.7,
  qa: 0.45,
  bugFixer: 0.35,
  security: 0.3,
  reviewer: 0.35,
};

const SIZE_FACTOR: Record<MissionPlan['size'], number> = { XS: 0.35, S: 0.6, M: 1, L: 1.6, XL: 2.4 };
const DEPTH_FACTOR: Record<Depth, number> = { off: 0, light: 0.6, full: 1 };

interface RoleStats {
  calls: number;
  costUsd: number;
  ms: number;
}

export interface Stats {
  version: 1;
  roles: Partial<Record<RoleId, RoleStats>>;
  missions: number;
}

export function readStats(root: string): Stats {
  try {
    return JSON.parse(fs.readFileSync(paths(root).stats, 'utf8')) as Stats;
  } catch {
    return { version: 1, roles: {}, missions: 0 };
  }
}

export function recordStats(root: string, calls: Array<{ role: RoleId; costUsd: number; ms: number }>): void {
  if (!fs.existsSync(paths(root).dir)) return;
  const stats = readStats(root);
  for (const c of calls) {
    const s = (stats.roles[c.role] ??= { calls: 0, costUsd: 0, ms: 0 });
    s.calls += 1;
    s.costUsd += c.costUsd;
    s.ms += c.ms;
  }
  stats.missions += 1;
  fs.writeFileSync(paths(root).stats, JSON.stringify(stats, null, 2) + '\n');
}

/** Typical cost of one call by this role on this project (own history once there are a few calls). */
export function typicalCost(stats: Stats, role: RoleId): number {
  const s = stats.roles[role];
  return s && s.calls >= 2 ? s.costUsd / s.calls : DEFAULT_COST[role];
}

export function estimateMission(stats: Stats, size: MissionPlan['size'], lineup: Lineup): number {
  const f = SIZE_FACTOR[size];
  let total = typicalCost(stats, 'developer') * f;
  total += lineup.pm === 'full' ? typicalCost(stats, 'pm') * f : 0;
  total += lineup.architect === 'full' ? typicalCost(stats, 'architect') * f : 0;
  for (const m of ['qa', 'security', 'reviewer'] as const) total += typicalCost(stats, m) * f * DEPTH_FACTOR[lineup[m]];
  // one expected fix round for anything that gets tested
  if (lineup.qa !== 'off') total += typicalCost(stats, 'bugFixer') * f * 0.5;
  return Math.round(total * 100) / 100;
}

export function costTable(stats: Stats): string {
  const roles: RoleId[] = ['pm', 'architect', 'developer', 'qa', 'bugFixer', 'security', 'reviewer'];
  const rows = roles.map((r) => {
    const s = stats.roles[r];
    const source = s && s.calls >= 2 ? `this project, ${s.calls} calls` : 'default estimate';
    return `| ${r} | $${typicalCost(stats, r).toFixed(2)} | ${source} |`;
  });
  return ['| Member role | Typical cost per call (medium task, full depth) | Source |', '|---|---|---|', ...rows].join('\n') +
    `\n\nScale by size (XS ×${SIZE_FACTOR.XS}, S ×${SIZE_FACTOR.S}, M ×1, L ×${SIZE_FACTOR.L}, XL ×${SIZE_FACTOR.XL}) and depth (light ×${DEPTH_FACTOR.light}).`;
}
