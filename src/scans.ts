import type { DiffMetrics } from './guardrails.js';
import { isDocFile, isTestFile } from './guardrails.js';
import type { Severity } from './schemas.js';

/**
 * Deterministic pattern scan of the lines a mission added. These are LEADS, not verdicts:
 * EDITH and TARS verify each one, because pattern matches can be false positives.
 */

export interface ScanLead {
  rule: string;
  title: string;
  severity: Severity;
  standard: string;
  audience: 'security' | 'reviewer';
  file: string;
  snippet: string;
}

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  standard: string;
  audience: 'security' | 'reviewer';
  pattern: RegExp;
  /** Also scan test files (secrets matter everywhere). */
  inTests?: boolean;
}

const RULES: Rule[] = [
  { id: 'secret-aws-key', title: 'AWS access key in code', severity: 'CRITICAL', standard: 'A04:2025, CWE-798', audience: 'security', pattern: /\bAKIA[0-9A-Z]{16}\b/, inTests: true },
  { id: 'secret-private-key', title: 'Private key in code', severity: 'CRITICAL', standard: 'A04:2025, CWE-321', audience: 'security', pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/, inTests: true },
  { id: 'secret-literal', title: 'Hard-coded secret, password or API key', severity: 'HIGH', standard: 'A04:2025, CWE-798', audience: 'security', pattern: /(secret|passw(or)?d|api[_-]?key|access[_-]?token|private[_-]?key)\w*\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i },
  { id: 'secret-jwt', title: 'JWT literal in code', severity: 'MEDIUM', standard: 'A04:2025, CWE-798', audience: 'security', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { id: 'eval', title: 'Dynamic code execution (eval / new Function)', severity: 'HIGH', standard: 'A05:2025, CWE-95', audience: 'security', pattern: /\beval\s*\(|new Function\s*\(/ },
  { id: 'command-exec', title: 'Shell command execution', severity: 'MEDIUM', standard: 'A05:2025, CWE-78', audience: 'security', pattern: /\b(exec|execSync|spawn|spawnSync)\s*\(\s*[`'"].*(\$\{|\+)|child_process/ },
  { id: 'xss-html', title: 'Raw HTML injection point', severity: 'MEDIUM', standard: 'A05:2025, CWE-79', audience: 'security', pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=|v-html=|\|\s*safe\b|mark_safe\(/ },
  { id: 'nosql-server-js', title: 'Server-side JavaScript in a Mongo query', severity: 'HIGH', standard: 'A05:2025, CWE-943', audience: 'security', pattern: /\$where|\$function|\$accumulator/ },
  { id: 'nosql-raw-input', title: 'Request object passed straight into a query', severity: 'HIGH', standard: 'A05:2025, CWE-943', audience: 'security', pattern: /\.(find|findOne|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|countDocuments|where)\s*\(\s*req\.(body|query|params)\s*[,)]/ },
  { id: 'regex-user-input', title: 'User input compiled into a regular expression', severity: 'MEDIUM', standard: 'A05:2025, CWE-1333 / CWE-625', audience: 'security', pattern: /new RegExp\s*\([^)]*(req\.|query|params|body|search|term|input|filter)|\$regex\s*:\s*(?!['"`/])[\w.]+/i },
  { id: 'regex-on-input', title: 'Regular expression applied to request data — check for catastrophic backtracking (ReDoS) and cap the length before matching', severity: 'MEDIUM', standard: 'A06:2025, CWE-1333', audience: 'security', pattern: /\bpattern\s*:\s*[A-Za-z_/]|\.test\(\s*(req\.|value\b|input\b|body\b|email\b|name\b|text\b|search\b|query\b|term\b)/ },
  { id: 'mass-assignment', title: 'Request body spread into a model or update', severity: 'HIGH', standard: 'API3:2023, CWE-915', audience: 'security', pattern: /\$set\s*:\s*req\.body|\.\.\.\s*req\.body|Object\.assign\([^,]+,\s*req\.body|\.(create|insertOne|update)\(\s*req\.body\s*\)/ },
  { id: 'sql-concat', title: 'SQL built from strings with input', severity: 'HIGH', standard: 'A05:2025, CWE-89', audience: 'security', pattern: /(SELECT|INSERT|UPDATE|DELETE)\b[^;'"`]*['"`]\s*\+\s*\w|`\s*(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|\$queryRawUnsafe|\.raw\(\s*`[^`]*\$\{/i },
  { id: 'path-traversal', title: 'Request data used in a file path', severity: 'HIGH', standard: 'A01:2025, CWE-22', audience: 'security', pattern: /(readFile|readFileSync|createReadStream|sendFile|unlink|writeFile)\s*\([^)]*req\.(params|query|body)/ },
  { id: 'ssrf', title: 'Server-side request to a caller-controlled URL', severity: 'HIGH', standard: 'A01:2025, CWE-918', audience: 'security', pattern: /(fetch|axios(\.\w+)?|got|request|http\.get|https\.get)\s*\(\s*req\.(body|query|params)/ },
  { id: 'open-redirect', title: 'Redirect to a caller-controlled URL', severity: 'MEDIUM', standard: 'A01:2025, CWE-601', audience: 'security', pattern: /res\.redirect\s*\(\s*req\.(query|body|params)/ },
  { id: 'weak-random', title: 'Math.random used for a security value', severity: 'HIGH', standard: 'A04:2025, CWE-338', audience: 'security', pattern: /(token|secret|code|otp|password|nonce|salt|key)\w*\s*[:=].*Math\.random\(|Math\.random\(\).*\b(token|secret|otp|nonce)\b/i },
  { id: 'weak-hash', title: 'Weak hash (MD5/SHA-1)', severity: 'MEDIUM', standard: 'A04:2025, CWE-328', audience: 'security', pattern: /createHash\(\s*['"](md5|sha1)['"]\s*\)|hashlib\.(md5|sha1)\(/i },
  { id: 'jwt-unverified', title: 'JWT decoded without verification or with alg "none"', severity: 'HIGH', standard: 'A07:2025, CWE-347', audience: 'security', pattern: /jwt\.decode\s*\(|algorithms\s*:\s*\[\s*['"]none['"]/i },
  { id: 'tls-disabled', title: 'TLS certificate verification disabled', severity: 'HIGH', standard: 'A04:2025, CWE-295', audience: 'security', pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False/ },
  { id: 'cors-wildcard', title: 'Permissive CORS', severity: 'MEDIUM', standard: 'A02:2025, CWE-942', audience: 'security', pattern: /origin\s*:\s*(['"]\*['"]|true)|cors\(\s*\)|Access-Control-Allow-Origin['"]?\s*,\s*['"]\*/ },
  { id: 'debug-log', title: 'Debug logging left in code', severity: 'LOW', standard: 'Rulebook: no debug leftovers', audience: 'reviewer', pattern: /^\s*(console\.(log|debug)\(|debugger;|print\()/ },
  { id: 'todo', title: 'TODO/FIXME left in new code', severity: 'LOW', standard: 'Rulebook: no debug leftovers', audience: 'reviewer', pattern: /\b(TODO|FIXME|XXX|HACK)\b/ },
];

const MAX_LEADS = 40;

export function scanDiff(metrics: DiffMetrics): ScanLead[] {
  const leads: ScanLead[] = [];
  for (const file of metrics.files) {
    const p = file.path.replace(/\\/g, '/');
    if (isDocFile(p) || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p)) continue;
    const test = isTestFile(p);
    for (const rule of RULES) {
      if (test && !rule.inTests) continue;
      const hit = file.addedLines.find((line) => rule.pattern.test(line));
      if (hit) {
        leads.push({ rule: rule.id, title: rule.title, severity: rule.severity, standard: rule.standard, audience: rule.audience, file: p, snippet: hit.trim().slice(0, 160) });
        if (leads.length >= MAX_LEADS) return leads;
      }
    }
  }
  return leads;
}
