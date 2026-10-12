# ai-engineering-team

**An AI engineering team for your repository, led by JARVIS.** Give it a request; JARVIS sizes the work, picks the right people, and the team takes it from idea to tested, reviewed code — with a visual mission report at the end.

```bash
npm install -g ai-engineering-team
cd your-project
ai-team init                     # JARVIS studies your codebase and writes the team's rules
ai-team build "Allow instructors to create discount coupons for their courses"
```

## Meet the team

| | Member | Role | From | What they're best at |
|---|---|---|---|---|
| 🧠 | **JARVIS** | Team Lead | Iron Man | Sizes every mission, staffs the team, writes briefs, settles disputes, reports to you |
| 🔭 | **VISION** | Product Manager | Avengers | Testable requirements, permission matrices, the edge cases nobody thought of |
| 📐 | **DATA** | Architect | Star Trek | Designs that fit your codebase: data model, API contracts, file plan, decision records |
| 🦾 | **FRIDAY** | Developer | Iron Man | Builds it in your codebase's own style, with tests |
| 🔬 | **EVE** | QA Engineer | WALL·E | Tries to break it — with real requests, concurrency tests and evidence |
| 🩺 | **BAYMAX** | Bug Fixer | Big Hero 6 | On call: root causes, minimal fixes, regression tests |
| 🔐 | **EDITH** | Security Reviewer | Spider-Man: Far From Home | Thinks like an attacker: OWASP Top 10:2025, API Top 10, STRIDE |
| 🤖 | **TARS** | Code Reviewer | Interstellar | *Honesty setting: 100%.* Would this PR pass a production review? |
| 🔴 | **HAL 9000** | Release Gate | 2001: A Space Odyssey | Not an AI: plain code you can't talk your way past |

Rename anyone: `"team": { "names": { "developer": "Chitti" } }` in `.ai-team/config.json`.

## Not every request is a build

JARVIS first works out what you actually want:

| You ask | What happens |
|---|---|
| a question — *"How does auth work here?"* | JARVIS (or DATA, for deeper questions) answers with `file:line` evidence, right in the terminal. Nothing is changed and no tests run; usually one AI call. |
| for a plan — *"Plan how we'd add multi-currency pricing"* | DATA writes the design: decisions with trade-offs, data model, API, risks and ordered milestones. Nothing is built. |
| to fix a bug — *"Page 1 never shows the oldest orders"* | FRIDAY works in debugging mode: reproduce with a failing test, confirm the root cause, fix, prove it. |
| for a change | A build mission, sized as below. |

## JARVIS keeps small tasks small

Multi-agent work costs many times more than a single agent, so JARVIS sizes every mission first and staffs only what it needs:

| Size | Example | Team |
|---|---|---|
| XS | change an error message | FRIDAY alone (checks still run) |
| S | small behavior change | FRIDAY + light QA/review |
| M | new endpoint with permissions | + VISION, EVE, TARS (EDITH if there's risk) |
| L | coupons, a new data model | + DATA, full depth on the risky parts |
| XL | payments, auth flows, migrations | everyone, full depth |

He also sets each member's **effort** (how hard they think) per mission, and you can cap spending: `ai-team build "…" --budget 3` pauses the mission (resumable) instead of overspending.

**Guardrails JARVIS can't override.** After every code change, plain code measures the real diff. If it's bigger than planned, touches security-sensitive code (auth, payments, uploads, secrets) or changes dependencies, the reviewers join automatically. Cutting cost never skips a check the change actually needs.

**The team can grow mid-mission.** A role is expertise, not a limit on what someone may notice. Any member can raise a *signal*: a **concern** for a teammate (EVE challenging the design, FRIDAY doubting the spec), an **assumption** they made (so testers don't report it as a bug), a **recruit** request (*"this needs a security review"* — the member joins), a **blocker** (JARVIS rules on it), or a **question** for you (asked once, only when it materially changes the result — and if your answer differs from the default, the work goes back). Each member sees only what's meant for them.

**Loops are cheap.** FRIDAY fixes what QA finds in her own session (she already knows the code, and her context is cached); BAYMAX steps in with fresh eyes when JARVIS asks for a different approach. Re-tests and re-reviews look only at what changed since the member last looked.

## The team writes its own rules

- **Day one (`ai-team init`)** — JARVIS studies your repository and writes `.ai-team/project.md` (stack, architecture diagram, conventions with file evidence, how to run and test), **project-specific rules** derived from your code, and notes for each teammate.
- **Stack packs** — expert checklists that switch on automatically: Express, MongoDB, React, Next.js, NestJS, SQL/ORMs, Python web.
- **After every mission** — JARVIS adds, updates or retires *learned rules* in `.ai-team/rules.md` based on what the mission taught the team. You can edit everything.

## What you see

**Live Mission Control** in your terminal — who's working, on what, and the cost so far:

```
 AI ENGINEERING TEAM ▸ Course discount coupons                  04:12 · $1.84 · round 1/5
 ──────────────────────────────────────────────────────────────────────────────────────
  🧠 JARVIS    Team Lead          ✓ L · risk high (payments, concurrency) · team of 6
  🔭 VISION    Product Manager    ✓ 9 criteria · 12 edge cases
  📐 DATA      Architect          ✓ 3 decisions · 5 files planned
  🦾 FRIDAY    Developer          ✓ 5 file(s) · 14 test(s)
  🔬 EVE       QA Engineer        ⠹ testing (round 1) · 01:12
                                  ↳ Bash node .ai-team/runs/…/qa-lab-1/race.mjs
  🩺 BAYMAX    Bug Fixer          · joins only if something breaks
  🔐 EDITH     Security Reviewer  ○ full depth
  🤖 TARS      Code Reviewer      ○ full depth
  🔴 HAL 9000  Release Gate       · waiting
```

**The Mission Report** — one HTML page that opens when the mission ends (`ai-team report` any time). It shows:

- the verdict and JARVIS's debrief
- the release gate and the team: who JARVIS picked, who wasn't needed, who a guardrail added
- a timeline of who worked when
- **requirements traceability**: every acceptance criterion → code → test → QA evidence
- QA results by category and **bug journeys** (found → fixed → verified)
- security and review findings with OWASP/CWE tags, plus the threat model
- what changed, and where the time and money went
- rulebook updates, and a **war room** chat of every handoff

It works in light and dark mode. Every mission also leaves Markdown artifacts in `.ai-team/runs/<mission>/` (plan, spec, design with Mermaid diagrams, QA reports, fixes, reviews, release, debrief) and resumable state.

## Why you can trust the result

- **Typed contracts.** Every member returns JSON that must match a schema; the orchestrator — not the model — decides what blocks.
- **Report everything, filter in code.** Reviewers report every issue with an honest severity; HAL blocks on CRITICAL/HIGH/MEDIUM. (Asking a model to "only report important issues" makes it report less.)
- **Checks run by the orchestrator**: lint, typecheck, tests and build, both *before* the mission (so failures that already existed aren't blamed on the team) and after every change. Agents can't fake them.
- **Fresh verdicts only.** Every verdict is tied to the code revision it judged; a later change invalidates it.
- **Done means done.** A successful agent response isn't proof. HAL fails the mission when the developer reported an acceptance criterion as partial, when a part of the system JARVIS planned (frontend, tests, docs) wasn't touched, when nothing changed at all, or when a blocker is still open — and the orchestrator sends such work back *before* anyone spends money testing it.
- **Least privilege, enforced by code.** Read-only members can't edit; EVE writes only in her scratch lab; nobody touches `.ai-team/` or `.git/`. QA needs a shell to run tests, so after every read-only member's turn the orchestrator compares the working tree with a snapshot and puts back anything they changed.
- **Bounded loops and a real lead.** Fix rounds are capped. When a bug keeps coming back or a fixer disputes it, JARVIS rules: fix it differently, waive it (only MEDIUM/LOW), or escalate to you.
- **Resumable.** Crash, Ctrl+C or budget pause → `ai-team resume`.

## Proving Ground

We measure, not guess. `bench/` contains a realistic Express + MongoDB-style API and four tasks with **hidden tests** the team never sees (IDOR, mass assignment, NoSQL injection, ReDoS, race conditions on coupon limits, data leaks…).

| Task | Plain Claude Code | v0.1 | v0.2 |
|---|---|---|---|
| Tiny change (XS) | 3/3 · $0.15 | 3/3 · $1.13 | 3/3 · $0.23 |
| Search (M) | 10/10 · $0.29 | 10/10 · $2.50 | 10/10 · $1.44 |
| Profile update (M, security trap) | **14/15** · $0.29 | 15/15 · $5.67 | **15/15** · $1.51–2.25 |
| Coupons (L, money + race) | 13/13 · $0.64 | 13/13 · $3.44 | 13/13 · $6.60 |

The honest summary: a single modern agent is strong and cheap. The team's edge is depth on risky work — EDITH catches attacks a solo developer misses — plus a verified, documented process. That's why JARVIS keeps small tasks small. Full results: [bench/RESULTS.md](bench/RESULTS.md); research: [docs/research.md](docs/research.md).

```bash
node bench/run.mjs --reference                                  # prove the hidden tests are fair
node bench/run.mjs --cli dist/cli.js --label mine --parallel 4  # score a version
node bench/run.mjs --solo --label solo                          # baseline: one plain Claude Code agent
node bench/compare.mjs
```

## Commands

| Command | What it does |
|---|---|
| `ai-team init` | Scaffold `.ai-team/` and let JARVIS onboard (`--skip-onboarding` to skip) |
| `ai-team onboard` | Re-study the codebase; refresh the project profile, rules and notes |
| `ai-team build "<request>"` | Run a mission — a question, a plan, a bug fix or a change. Options: `--budget <usd>`, `--quick`, `--full`, `--yes`, `--git`, `--max-iterations <n>`, `--model <id>`, `--quiet`, `--no-live`, `--no-open` |
| `ai-team resume [id]` | Continue a paused or failed mission (`--budget` raises the limit) |
| `ai-team status [id]` · `ai-team runs` | Mission status · list of missions |
| `ai-team report [id]` | Open the visual mission report |
| `ai-team team` | Meet the team |
| `ai-team doctor` | Check Node, config, checks, onboarding and Claude access |

When a member finds a real product question they ask you (`Q-2: Can coupons stack? [Enter = no]`); `--yes` accepts the proposed defaults. Answers, solo changes and plans finish in the terminal; the HTML mission report opens for team missions and plans.

## Configuration — `.ai-team/config.json`

```jsonc
{
  "mode": "auto",                 // auto (JARVIS decides) | quick | full
  "budgetUsd": 5,                 // optional limit per mission
  "maxIterations": 5,             // fix/rework rounds before HAL rejects
  "checks": [{ "name": "test", "command": "npm run test" }],   // auto-detected
  "baselineChecks": true,
  "team": { "names": { "developer": "FRIDAY" } },
  "models": { "reviewer": "claude-opus-5-5" },  // optional per-role model
  "effort": { "security": "high" },             // optional per-role effort override
  "guardrails": { "soloMaxChangedLines": 40, "soloMaxFiles": 3, "sensitivePaths": [] },
  "loop": { "deferNewIssuesFromRound": 3, "fixer": "auto" },  // "bugFixer": BAYMAX fixes every QA finding
  "rules": { "autoLearn": true, "maxLearned": 40 },
  "git": { "branch": false, "commit": false },  // or --git
  "ui": { "live": true, "emoji": true, "openReport": true },
  "permissions": "allowlist"      // "bypass" only in sandboxes; write limits still apply
}
```

To customize a member completely, drop a playbook into `.ai-team/playbooks/<name>.md` (see `templates/playbooks/`). For lighter tweaks, add project notes in `.ai-team/team/<role>.md`.

## Requirements

Node.js 20+, and access to Claude: a Claude Code login on this machine (run `claude` once) or `ANTHROPIC_API_KEY`. The Claude Code runtime is bundled through the Claude Agent SDK.

## Programmatic use

```ts
import { Orchestrator, ClaudeCodeProvider, loadConfig } from 'ai-engineering-team';

const root = process.cwd();
const outcome = await new Orchestrator({ root, config: loadConfig(root), provider: new ClaudeCodeProvider() })
  .build('Add a health check endpoint', { budgetUsd: 2 });
console.log(outcome.state.status, outcome.reportPath);
```

## Roadmap

- EVE testing UIs in a real browser, with screenshots in the report
- GitHub: open a PR with the mission report, watch CI and fix failures
- Talk to members directly inside Claude Code (`@EDITH review my auth middleware`)
- A dashboard across missions; more model providers

## License

MIT
