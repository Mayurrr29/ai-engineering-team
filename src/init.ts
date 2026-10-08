import fs from 'node:fs';
import path from 'node:path';
import { detectChecks, type Config } from './config.js';
import { paths, TEMPLATES_DIR } from './paths.js';
import { ROLES } from './roles.js';

export interface InitResult {
  created: string[];
  skipped: string[];
  config: Partial<Config>;
}

/** Scaffolds .ai-team/ in a project. Never overwrites existing files unless force is set. */
export function initProject(root: string, force = false): InitResult {
  const p = paths(root);
  const created: string[] = [];
  const skipped: string[] = [];
  const write = (file: string, content: string) => {
    if (fs.existsSync(file) && !force) {
      skipped.push(path.relative(root, file));
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    created.push(path.relative(root, file));
  };
  const copy = (from: string, to: string) => write(to, fs.readFileSync(path.join(TEMPLATES_DIR, from), 'utf8'));

  const config: Partial<Config> = {
    mode: 'standard',
    maxIterations: 5,
    checks: detectChecks(root),
    checkTimeoutSec: 900,
    git: { branch: false, commit: false },
    permissions: 'allowlist',
  };
  write(p.config, JSON.stringify(config, null, 2) + '\n');
  copy('rules.md', p.rules);
  copy('memory/lessons.md', p.lessons);
  for (const role of Object.values(ROLES)) copy(path.join('agents', role.file), path.join(p.agents, role.file));
  fs.mkdirSync(p.runs, { recursive: true });

  return { created, skipped, config };
}
