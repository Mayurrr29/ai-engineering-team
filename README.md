# ai-engineering-team

**An AI engineering team for your repository.** Give it one feature request; it takes the feature from requirements to reviewed, tested code — the way a real engineering org would:

```
 PM → Developer → Checks → QA ──bugs──► Bug Fixer ──┐
                             ▲                      │
                             └──────────────────────┘
                     QA pass → Security → Code Review ──reject──► Developer → Checks → QA → …
                                                   approve → Release gate → APPROVED ✅ / REJECTED ❌
```

```bash
npm install -g ai-engineering-team
cd your-project
ai-team init
ai-team build "Allow instructors to create discount coupons for their courses"
```

```
[1] Product Manager
  ✓ Requirements: 9 functional, 8 acceptance criteria
  ✓ 17 edge cases identified
[2] Developer
  ✓ 7 file(s) changed, 3 test(s) added
[3] Checks (lint / typecheck / tests / build)
  ✓ lint (4.1s)  ✓ test (8.3s)  ✓ build (6.0s)
[4] QA Engineer
  ✓ 43 test scenarios
  ✗ 2 issue(s): BUG-001, BUG-002
[5] Bug Fixer
  ✓ BUG-001 fixed  ✓ BUG-002 fixed
  …
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
             RELEASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Requirements:   PASS — 8 acceptance criteria, 17 edge cases
Implementation: PASS — 3 code revision(s)
Checks:         PASS — lint, test, build
QA:             PASS — 43 scenarios
Security:       PASS
Code Review:    PASS
Iterations:     PASS — 2/5

STATUS: APPROVED ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Why it works better than "Claude, build this feature"

- **Separate roles with separate mindsets.** The PM finds ambiguity; the developer builds exactly what was specified; QA assumes bugs exist and tries to prove it; the security reviewer thinks like an attacker; the code reviewer asks *"would I approve this PR?"*
- **Agents don't trust each other.** QA verifies the developer's claims by running things. Reviewers read the real diff, not summaries.
- **Least privilege.** PM, Security and Code Review are read-only. QA can run commands but not edit files. Only the Developer and Bug Fixer can change code.
- **Typed contracts, not vibes.** Every agent must return JSON matching a schema (requirements, bug reports, findings with severities). The orchestrator — not the model — decides what blocks.
- **Deterministic gates.** Lint/typecheck/tests/build are run by the orchestrator itself; an agent can't claim they pass. The release gate is plain code: every verdict must be a pass **and** must have been made against the *current* code version, so a stale approval can never ship a later change.
- **Bounded loops.** Fix/rework rounds are capped (`maxIterations`); if the team can't converge, the feature is rejected with reasons.
- **Resumable.** State is saved after every step. Crash, Ctrl+C, network error → `ai-team resume`.
- **Engineering memory.** Reviewers record durable project lessons into `.ai-team/memory/lessons.md`; every agent reads them on the next feature.

## Requirements

- Node.js 20+
- Access to Claude: either you're logged in to **Claude Code** on this machine (run `claude` once), or `ANTHROPIC_API_KEY` is set. The Claude Code runtime is bundled via the Claude Agent SDK — no separate install needed.

Check your setup with `ai-team doctor`.

## Commands

| Command | What it does |
|---|---|
| `ai-team init` | Creates `.ai-team/` with config, rules, agent prompts and memory. Auto-detects `lint`/`typecheck`/`test`/`build` scripts. Never overwrites (use `--force`). |
| `ai-team build "<feature>"` | Runs the full workflow. |
| `ai-team build "<feature>" --quick` | Developer → QA → Code Review (no PM spec, no security review). For small changes. |
| `ai-team resume [run-id]` | Continues a failed/interrupted run from its last unfinished step. |
| `ai-team status [run-id]` | Shows the status board of a run. |
| `ai-team runs` | Lists all runs. |
| `ai-team doctor` | Checks Node, config, checks and Claude connectivity. |

`build` options: `--yes` (don't ask the PM's open questions, accept proposed defaults), `--max-iterations <n>`, `--model <id>`, `--git` (branch + commit per step), `--quiet` (hide live agent activity).

When the PM finds real ambiguity it asks you (e.g. *"Q-2: Can a coupon be combined with other discounts? [Enter = no]"*). Your answers become part of the approved spec.

## What gets created

```
.ai-team/
├── config.json          # workflow settings + checks
├── rules.md             # your project constitution — every agent must follow it
├── agents/              # role prompts — customize freely
│   ├── pm.md  developer.md  qa.md  bug-fixer.md  security.md  reviewer.md
├── memory/
│   └── lessons.md       # learned conventions, grows over time
└── runs/
    └── 20261008-1412-add-course-coupons/
        ├── request.md
        ├── 01-requirements.md
        ├── 02-implementation.md
        ├── 03-checks-v1.md
        ├── 04-qa-round1.md
        ├── 05-fix-round1.md
        ├── …
        ├── 11-release.md
        └── state.json   # resumable workflow state
```

Every run leaves a full audit trail: what was asked, what was specified, what was built, what broke, how it was fixed, and why it was approved.

## Configuration — `.ai-team/config.json`

```jsonc
{
  "mode": "standard",            // or "quick"
  "maxIterations": 5,            // fix/rework rounds before the gate rejects
  "checks": [                    // run by the orchestrator, not the AI
    { "name": "lint", "command": "npm run lint" },
    { "name": "test", "command": "npm run test" },
    { "name": "build", "command": "npm run build" }
  ],
  "checkTimeoutSec": 900,
  "git": { "branch": false, "commit": false },  // or pass --git
  "permissions": "allowlist",    // "bypass" only inside sandboxes/CI containers
  "model": "claude-sonnet-5-5",  // optional; defaults to your Claude Code model
  "models": { "reviewer": "claude-opus-5-5" },  // optional per-role override
  "maxBudgetUsdPerAgent": 5,     // optional spend cap per agent call
  "maxTurnsPerAgent": 200
}
```

Agents also load your project's `CLAUDE.md` and Claude Code settings, so existing project instructions apply.

**Git integration** (`--git`): creates `ai-team/<feature>` and commits after each implementation/fix step, producing a reviewable history. It only activates on a clean working tree, so your uncommitted work is never mixed in. It never pushes.

## Severity rules

- QA: any bug, or any failing check, sends the work to the Bug Fixer.
- Security & Code Review: any `CRITICAL`, `HIGH` or `MEDIUM` finding rejects — even if the agent itself wrote "APPROVED". `LOW` findings are recorded but don't block.

## Programmatic use

```ts
import { Orchestrator, ClaudeCodeProvider, loadConfig } from 'ai-engineering-team';

const root = process.cwd();
const outcome = await new Orchestrator({ root, config: loadConfig(root), provider: new ClaudeCodeProvider() })
  .build('Add a health check endpoint');
console.log(outcome.state.status); // 'approved' | 'rejected' | 'failed'
```

Providers implement a single method (`run(request) → { output, costUsd, turns }`), so other models can be plugged in. `MockProvider` is included for testing your own workflows.

## Roadmap

- **v0.2** — GitHub: push branch, open PR with the release report, watch CI and fix failures.
- **v0.3** — Architect agent for large features; parallel QA/security/review.
- **v0.4** — `ai-team dashboard`: local web UI for runs, artifacts, costs.
- **v0.5** — More providers (OpenAI, Gemini, local models).

## License

MIT
