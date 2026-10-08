import type { Config } from './config.js';
import type { DiffFile } from './git.js';
import type { Depth, Lineup, MissionPlan, RiskArea } from './schemas.js';

/**
 * Guardrails are deterministic code that can only ever ADD members or depth to JARVIS's plan.
 * They keep cost-cutting from skipping a check the change actually needs.
 */

const RANK: Record<Depth, number> = { off: 0, light: 1, full: 2 };

export interface Upgrade {
  member: keyof Lineup;
  to: Depth;
  reason: string;
}

export interface GuardrailResult {
  lineup: Lineup;
  upgrades: Upgrade[];
}

function raise(lineup: Lineup, member: keyof Lineup, to: Depth, reason: string, upgrades: Upgrade[]): void {
  const current = lineup[member] as Depth;
  // pm and architect only have off/full
  const target: Depth = (member === 'pm' || member === 'architect') && to === 'light' ? 'full' : to;
  if (RANK[target] > RANK[current]) {
    (lineup as Record<string, Depth>)[member] = target;
    upgrades.push({ member, to: target, reason });
  }
}

/** Makes the lineup consistent with JARVIS's own size and risk assessment. */
export function planGuardrails(plan: Pick<MissionPlan, 'size' | 'risk' | 'riskAreas' | 'lineup'>): GuardrailResult {
  const lineup: Lineup = { ...plan.lineup };
  const upgrades: Upgrade[] = [];
  const big = plan.size === 'L' || plan.size === 'XL';
  if (plan.size === 'M' || big) {
    raise(lineup, 'qa', 'light', `size ${plan.size} needs testing`, upgrades);
    raise(lineup, 'reviewer', 'light', `size ${plan.size} needs review`, upgrades);
  }
  if (big) {
    raise(lineup, 'pm', 'full', `size ${plan.size} needs a spec`, upgrades);
    raise(lineup, 'qa', 'full', `size ${plan.size} needs full testing`, upgrades);
    raise(lineup, 'reviewer', 'full', `size ${plan.size} needs a full review`, upgrades);
  }
  if (plan.size === 'XL') raise(lineup, 'architect', 'full', 'size XL needs a design', upgrades);
  if (plan.riskAreas.length) {
    const areas = plan.riskAreas.join(', ');
    raise(lineup, 'security', 'light', `risk areas: ${areas}`, upgrades);
    raise(lineup, 'reviewer', 'light', `risk areas: ${areas}`, upgrades);
  }
  if (plan.risk === 'high') {
    for (const m of ['security', 'qa', 'reviewer'] as const) raise(lineup, m, 'full', 'high-risk mission', upgrades);
  }
  const money: RiskArea[] = ['payments', 'concurrency'];
  if (plan.riskAreas.some((a) => money.includes(a))) raise(lineup, 'qa', 'full', 'money or concurrency needs adversarial testing', upgrades);
  if (plan.riskAreas.includes('data-migration')) raise(lineup, 'architect', 'full', 'data migration needs a design', upgrades);
  return { lineup, upgrades };
}

const DEFAULT_SENSITIVE_PATHS =
  /(auth|login|logout|signin|signup|register|session|jwt|oauth|passw|credential|permission|acl|admin|payment|billing|checkout|stripe|paypal|razorpay|invoice|wallet|upload|multer|crypto|secret|security|cors|csrf|(^|\/)\.env)/i;

const SENSITIVE_CONTENT =
  /(jsonwebtoken|\bjwt\.|bcrypt|argon2|scrypt|crypto\.|createHash|createHmac|randomBytes|\bpassword|passwd|\bsecret|api[_-]?key|private[_-]?key|req\.user|isAdmin|\brole\b|authoriz|cookie|set-cookie|cors\(|helmet|\beval\(|new Function\(|child_process|\bexec(Sync)?\(|\bspawn(Sync)?\(|dangerouslySetInnerHTML|innerHTML|\$where|\$regex|new RegExp\(|res\.redirect\(|sendFile\(|createReadStream\()/i;

const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|e2e|cypress|playwright)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|\/)test_[^/]*\.py$/i;
const DOC_FILE = /\.(md|mdx|txt|rst)$/i;
const DEP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$/;
const DEP_LINE = /^\s*"(@?[\w.-]+\/)?[\w.-]+"\s*:\s*"(npm:|workspace:|[~^><=*]|\d|latest|git|https?:)/;

export const isTestFile = (p: string) => TEST_FILE.test(p.replace(/\\/g, '/'));
export const isDocFile = (p: string) => DOC_FILE.test(p);

export interface DiffMetrics {
  files: DiffFile[];
  changedLines: number;
  /** False when line counts are unknown (not a git repository). */
  measured: boolean;
}

export function sensitiveMatches(metrics: DiffMetrics, extraPatterns: string[] = []): { paths: string[]; content: string[] } {
  const extra = extraPatterns.map((p) => new RegExp(p, 'i'));
  const paths: string[] = [];
  const content: string[] = [];
  for (const f of metrics.files) {
    const p = f.path.replace(/\\/g, '/');
    if (isDocFile(p)) continue;
    if (!isTestFile(p) && (DEFAULT_SENSITIVE_PATHS.test(p) || extra.some((r) => r.test(p)))) paths.push(p);
    if (!isTestFile(p) && f.addedLines.some((l) => SENSITIVE_CONTENT.test(l))) content.push(p);
  }
  return { paths, content };
}

export function dependencyChanges(metrics: DiffMetrics): string[] {
  const changed: string[] = [];
  for (const f of metrics.files) {
    const p = f.path.replace(/\\/g, '/');
    if (DEP_FILES.test(p)) changed.push(p);
    else if (/(^|\/)package\.json$/.test(p) && f.addedLines.some((l) => DEP_LINE.test(l))) changed.push(p);
  }
  return changed;
}

/** Re-checks the lineup against the change that was actually made. */
export function diffGuardrails(lineup: Lineup, metrics: DiffMetrics, cfg: Config['guardrails']): GuardrailResult {
  const next: Lineup = { ...lineup };
  const upgrades: Upgrade[] = [];
  const codeFiles = metrics.files.filter((f) => !isDocFile(f.path));
  if (codeFiles.length === 0) return { lineup: next, upgrades };

  if (codeFiles.length > cfg.soloMaxFiles || (metrics.measured && metrics.changedLines > cfg.soloMaxChangedLines)) {
    raise(next, 'reviewer', 'light', `the change is bigger than planned (${codeFiles.length} files${metrics.measured ? `, ${metrics.changedLines} lines` : ''})`, upgrades);
  }
  if (codeFiles.length > 8 || (metrics.measured && metrics.changedLines > 250)) {
    raise(next, 'reviewer', 'full', `large change (${codeFiles.length} files${metrics.measured ? `, ${metrics.changedLines} lines` : ''})`, upgrades);
    raise(next, 'qa', 'light', 'large change needs testing', upgrades);
  }
  const sensitive = sensitiveMatches(metrics, cfg.sensitivePaths);
  if (sensitive.paths.length) {
    const list = sensitive.paths.slice(0, 3).join(', ');
    raise(next, 'security', sensitive.paths.length >= 3 ? 'full' : 'light', `changes touch security-sensitive files (${list})`, upgrades);
    raise(next, 'reviewer', 'light', `changes touch security-sensitive files (${list})`, upgrades);
  } else if (sensitive.content.length) {
    const list = sensitive.content.slice(0, 3).join(', ');
    raise(next, 'security', 'light', `new code uses security-sensitive APIs (${list})`, upgrades);
    raise(next, 'reviewer', 'light', `new code uses security-sensitive APIs (${list})`, upgrades);
  }
  const deps = dependencyChanges(metrics);
  if (deps.length) {
    raise(next, 'security', 'light', `dependencies changed (${deps.join(', ')})`, upgrades);
    raise(next, 'reviewer', 'light', `dependencies changed (${deps.join(', ')})`, upgrades);
  }
  return { lineup: next, upgrades };
}

export function isSolo(lineup: Lineup): boolean {
  return lineup.pm === 'off' && lineup.architect === 'off' && lineup.qa === 'off' && lineup.security === 'off' && lineup.reviewer === 'off';
}
