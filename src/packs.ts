import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES_DIR } from './paths.js';
import { PACK_IDS } from './schemas.js';
import type { RoleId } from './team.js';

export type PackId = (typeof PACK_IDS)[number];

const DEPENDENCY_PACKS: Array<[PackId, RegExp]> = [
  ['express', /^express$/],
  ['mongodb', /^(mongoose|mongodb)$/],
  ['react', /^react$/],
  ['nextjs', /^next$/],
  ['nestjs', /^@nestjs\/core$/],
  ['sql', /^(pg|mysql2?|sqlite3|better-sqlite3|prisma|@prisma\/client|sequelize|typeorm|knex|drizzle-orm|kysely)$/],
];

/** Detects stack packs from dependency manifests. Cheap and deterministic. */
export function detectPacks(root: string): PackId[] {
  const found = new Set<PackId>();
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
      for (const [pack, pattern] of DEPENDENCY_PACKS) if (deps.some((d) => pattern.test(d))) found.add(pack);
    } catch {
      // unreadable package.json: no packs from it
    }
  }
  for (const file of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    const p = path.join(root, file);
    if (fs.existsSync(p) && /\b(django|flask|fastapi)\b/i.test(fs.readFileSync(p, 'utf8'))) found.add('python-web');
  }
  return [...found];
}

/**
 * Returns the sections of the given packs that apply to a role: `## @all` plus `## @<role>`.
 * Packs are markdown files in templates/packs with one section per member.
 */
export function packGuidance(packs: PackId[], role: RoleId): string {
  const parts: string[] = [];
  for (const id of packs) {
    const file = path.join(TEMPLATES_DIR, 'packs', `${id}.md`);
    if (!fs.existsSync(file)) continue;
    const { title, sections } = parsePack(fs.readFileSync(file, 'utf8'));
    const body = [sections.get('all'), sections.get(role)].filter(Boolean).join('\n');
    if (body.trim()) parts.push(`### ${title}\n\n${body.trim()}`);
  }
  return parts.join('\n\n');
}

export function parsePack(text: string): { id: string; title: string; sections: Map<string, string> } {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  const meta = Object.fromEntries((front?.[1] ?? '').split('\n').map((l) => l.split(/:\s*/, 2) as [string, string]));
  const body = front ? text.replace(/\r\n/g, '\n').slice(front[0].length) : text;
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of body.split('\n')) {
    const heading = /^## @(\w+)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, '');
    } else if (current) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    }
  }
  return { id: meta.id ?? '', title: meta.title ?? meta.id ?? 'Stack pack', sections };
}
