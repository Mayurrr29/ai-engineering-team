import fs from 'node:fs';
import path from 'node:path';
import { detectChecks, type Config } from './config.js';
import { paths, TEMPLATES_DIR } from './paths.js';
import { fillNames, type TeamNames } from './team.js';

export interface InitResult {
  created: string[];
  skipped: string[];
  config: Partial<Config>;
}

/** Scaffolds .ai-team/ in a project. Never overwrites existing files unless force is set. */
export function initProject(root: string, force = false, names: TeamNames = {}): InitResult {
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

  const config: Partial<Config> = {
    mode: 'auto',
    maxIterations: 5,
    checks: detectChecks(root),
    checkTimeoutSec: 900,
    git: { branch: false, commit: false },
    permissions: 'allowlist',
  };
  write(p.config, JSON.stringify(config, null, 2) + '\n');
  write(p.rules, fillNames(fs.readFileSync(path.join(TEMPLATES_DIR, 'rules.md'), 'utf8'), names));
  fs.mkdirSync(p.runs, { recursive: true });
  const ignore = path.join(p.dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# QA scratch files are throwaway\nruns/*/qa-lab-*/\n');

  return { created, skipped, config };
}
