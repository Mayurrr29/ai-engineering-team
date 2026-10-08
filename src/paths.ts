import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEAM_DIR = '.ai-team';

export function paths(root: string) {
  const dir = path.join(root, TEAM_DIR);
  return {
    dir,
    config: path.join(dir, 'config.json'),
    rules: path.join(dir, 'rules.md'),
    agents: path.join(dir, 'agents'),
    memory: path.join(dir, 'memory'),
    lessons: path.join(dir, 'memory', 'lessons.md'),
    runs: path.join(dir, 'runs'),
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
