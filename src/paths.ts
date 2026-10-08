import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEAM_DIR = '.ai-team';

export function paths(root: string) {
  const dir = path.join(root, TEAM_DIR);
  return {
    dir,
    config: path.join(dir, 'config.json'),
    rules: path.join(dir, 'rules.md'),
    project: path.join(dir, 'project.md'),
    projectJson: path.join(dir, 'project.json'),
    /** Per-member project notes written during onboarding (and editable by humans). */
    teamNotes: path.join(dir, 'team'),
    /** Optional full playbook overrides. */
    playbooks: path.join(dir, 'playbooks'),
    stats: path.join(dir, 'stats.json'),
    runs: path.join(dir, 'runs'),
    /** v0.1 locations, still read for compatibility. */
    legacyAgents: path.join(dir, 'agents'),
    legacyLessons: path.join(dir, 'memory', 'lessons.md'),
  };
}

/** The package's bundled templates directory (works from src/ via tsx and from dist/). */
export const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'feature';
}

/** True if `child` is `parent` or inside it (case-insensitive on Windows). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizeCase(path.resolve(parent)), normalizeCase(path.resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
