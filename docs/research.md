# R&D: building an AI engineering team that is actually good

This document records the research behind v0.2: what we studied, what we concluded, and how each conclusion shows up in the product. Results from the Proving Ground benchmark are in [`bench/RESULTS.md`](../bench/RESULTS.md).

## 1. How to run a team of agents

**Source:** Anthropic, *How we built our multi-agent research system*; *Building effective agents*.

| Finding | What we do with it |
|---|---|
| A lead agent must give every worker a real brief: an objective, an output format, guidance on tools, and clear task boundaries. Vague delegation made agents duplicate work and misread tasks. | JARVIS writes a brief for every member he staffs (objective, focus areas, boundaries, key files). Output formats are enforced by schemas. |
| Effort must scale with the task. Anthropic's early lead agents over-invested in simple queries; they fixed it with explicit rules (1 agent for simple work, 2–4 for comparisons, 10+ for complex research). | JARVIS sizes every mission (XS → XL) and staffs from an explicit scaling table, calibrated on the Proving Ground (section 6). An XS task goes to FRIDAY alone; an XL task gets everyone at full depth. |
| Multi-agent systems use ~15× the tokens of a chat. They are worth it only when the task's value justifies the cost. | Right-sizing, a per-run budget, per-member `effort` levels, and an on-call Bug Fixer who is only paid when something is broken. |
| Parallel work cut research time by up to 90%. | EDITH (security) and TARS (code review) review in parallel, and one rework round addresses both. |
| Evaluate end state, not every intermediate step. Start with a small set of realistic tasks; early changes have large effects. | The Proving Ground scores the final code with hidden tests, on a small set of realistic tasks. |
| Agents are stateful and errors compound; you can't just restart. | Every step is checkpointed; `ai-team resume` continues a failed or paused mission. |

## 2. How to prompt current Claude models

**Source:** Claude prompting best practices; *Prompting Claude Opus 5*.

- **Explain why, not just what.** Rules with reasons generalize to cases the rule didn't name. Every playbook rule carries its reason.
- **Calm language.** Current models over-react to "CRITICAL: you MUST". Playbooks use plain instructions.
- **Ask reviewers to report everything, and filter separately.** A review prompt that says "only report high-severity issues" makes the model report less. TARS and EDITH report every finding with an honest severity; HAL (plain code) decides what blocks.
- **Don't add "double-check" steps.** Current models verify their own work; extra verification instructions waste tokens. The orchestrator runs lint/tests/build itself, so agents don't need to be told to re-verify.
- **Control scope explicitly.** Without it, models widen tasks. FRIDAY and BAYMAX carry Anthropic's scope and anti-over-engineering guidance.
- **No test-specific hacks.** FRIDAY and BAYMAX are told to implement general solutions, never special-case test inputs, and to report incorrect tests instead of bending code around them.
- **Investigate before claiming.** Reviewers must read the code they comment on.
- **Use effort as the cost dial.** `low`/`medium` effort keeps quality at a fraction of the tokens; JARVIS sets effort per member per mission.

## 3. What existing multi-agent dev tools do — and miss

| Tool | Approach | Gap we address |
|---|---|---|
| BMAD Method | Persona prompts (Analyst, PM, Architect, Dev, QA…) coordinated through documents. "No code execution — the AI is the engine." | Nothing is verified by running code; quality depends on the model's honesty. We run checks ourselves and gate on real results. |
| MetaGPT | Standard operating procedures + structured documents per role. | Strong structure, weak verification and cost control. |
| ChatDev | Chat chains between role agents. | Role-play without execution evidence; long loops. |
| CrewAI | General framework; optional "manager" agent. | Not specialized for software delivery; no gates. |

**Our position:** typed contracts between members, deterministic checks and gates the agents can't talk past, verdicts tied to the exact code version they judged, and a team lead who right-sizes the work.

## 4. Best practice per discipline

| Member | Built on |
|---|---|
| **VISION** (PM) | INVEST user stories; Given/When/Then acceptance criteria; Example Mapping (rules → examples → questions); a permissions matrix (role × action × ownership); ISO/IEC 25010 quality characteristics for non-functional requirements. |
| **DATA** (Architect) | Architecture Decision Records (context, decision, alternatives, consequences); C4-style views and sequence/ER diagrams; consistent API contracts; data integrity (unique constraints, atomic conditional updates); expand/contract migrations. |
| **FRIDAY** (Developer) | Mirror existing patterns; tests from acceptance criteria first; minimal diffs; validation at system boundaries; Anthropic's scope and no-hard-coding guidance. |
| **EVE** (QA) | ISTQB test design (equivalence partitioning, boundary values, decision tables, state transitions, error guessing); Heuristic Test Strategy Model (SFDIPOT); Hendrickson's test heuristics (Goldilocks, Zero-One-Many, CRUD, Starve, Interrupt, Multi-user…); risk-based depth; evidence for every verdict. |
| **BAYMAX** (Bug Fixer) | Scientific debugging (observe → hypothesize → predict → experiment → conclude); reproduce first; regression test that fails before the fix and passes after; 5 Whys; check sibling occurrences. |
| **EDITH** (Security) | OWASP Top 10:2025 (incl. new A03 Supply Chain Failures, A10 Mishandling of Exceptional Conditions); OWASP API Security Top 10:2023 (BOLA, BOPLA, unrestricted resource consumption, BFLA, sensitive business flows); STRIDE threat modeling; source-to-sink verification. |
| **TARS** (Code Reviewer) | Google Engineering Practices (approve when code health improves; design, functionality, complexity, tests, naming, comments, consistency); Conventional Comments labels; traceability of every acceptance criterion. |
| **JARVIS** (Lead) | Anthropic's orchestrator–worker lessons above; decisive arbitration against the spec; honest, outcome-first reporting. |

## 5. The Proving Ground

A realistic Express 5 + MongoDB-style API (`bench/fixtures/learnhub-api`) with four tasks of different size and risk. Each task has **hidden tests** that the team never sees. They check the traps a strong team should catch:

| Scenario | Size | Traps checked by hidden tests |
|---|---|---|
| 01 Profile update | M | IDOR, mass assignment (`role: admin`), validation, duplicate email (Mongo E11000), NoSQL operator injection, password-hash leaks |
| 02 Coupons | L | Ownership, percent validation, course scoping, expiry, `maxRedemptions` including a **concurrent** double-redeem race, operator injection |
| 03 User search | M | Admin-only access, regex injection (`.*`, `(`), page-size cap, invalid paging, total counts, data leaks |
| 04 Tiny change | XS | Exact change, nothing else broken — and cost |

Fairness check: reference solutions pass 100% of hidden tests; the unchanged app fails them. Run it yourself: `node bench/run.mjs --reference`.

## 6. What we measured

Three contenders on the same four tasks, scored by hidden tests (full table: [`bench/RESULTS.md`](../bench/RESULTS.md)):

- **Solo Claude Code** — one agent with Claude Code's default prompt, told to implement the request with tests.
- **v0.1** — the fixed pipeline: PM → Dev → QA → Fix → Security → Review → gate, every member at full depth.
- **v0.2** — JARVIS sizes the mission and staffs the team (first run: `v0.2.0`; after calibration: `v0.2.1-calibrated`).

### Findings

1. **A single modern agent is strong.** Solo Claude Code passed 40/41 hidden tests for $1.37 in about 5 minutes across all four tasks — including the coupon race condition and the operator-injection traps. Any team has to justify its cost against that.
2. **Specialist security review is where the team earns its keep.** The new profile endpoint exposed an existing email regex that takes quadratic time. One crafted request froze the server for seconds. Solo Claude Code missed it. In v0.1, QA found it on a second round; in v0.2, EDITH found it in her first pass at *light* depth, with the exact attack, CWE-1333, and a linear-time fix.
3. **Breadth is not depth.** VISION wrote 19–24 acceptance criteria for medium tasks, and full-depth QA ran 20–40 scenarios per round at high effort ($0.72–1.00 per round). On these well-specified tasks neither found a blocking problem the developer had missed; they multiplied cost. v0.1 also spent full fix rounds on LOW-severity nitpicks.
4. **Right-sizing works when the size is obvious.** For the one-line change JARVIS sent FRIDAY alone: $0.33 instead of v0.1's $1.13 (−71%), same result.
5. **Over-staffing is the main cost risk.** In its first run v0.2 cost about the same as v0.1 overall ($13.26 vs $12.74): savings on small tasks were eaten by full-depth lineups on the large one (the coupons mission cost $6.39 with all six members at full depth).
6. **The team learns.** After the profile mission JARVIS added rules such as *"any regex used in a validate() schema must be unambiguous (no overlapping quantifiers)"* — the next mission on that project starts with the lesson.
7. **Onboarding is cheap and accurate.** 77–121 s and ~$0.35 per project produced profiles with 10–12 conventions (with file evidence), 7–9 project rules and 8–9 sensitive areas.
8. **Honest reporting.** On the coupons mission JARVIS's debrief flagged that QA had reported a LOW-severity over-reservation bug the gate did not block, and asked the human to confirm it before merging.

### Calibration applied after the first v0.2 run

- Leaner default staffing for M tasks: no PM unless the request is ambiguous; QA and code review at light depth; security review whenever there is a risk area (finding 2).
- A spec budget by mission size for VISION (finding 3).
- Re-test rounds run one effort level lower.
- A narrower definition of "high risk" (money, authentication flows, irreversible changes, newly exposed data).
- Planning examples moved to other domains. **Disclosure:** the playbooks used in `v0.2.0` contained example requests similar to two benchmark tasks; `v0.2.1-calibrated` uses neutral examples.

Single runs per task are noisy, and hidden tests can only check what we thought to test: treat small differences with caution.

## References

- Anthropic — [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system); [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Claude docs — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices); [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- OWASP — [Top 10:2025](https://top10.owasp.org/2025/); [API Security Top 10:2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/); [ASVS](https://owasp.org/www-project-application-security-verification-standard/)
- Microsoft — [STRIDE threat categories](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)
- Google — [Engineering Practices: code review](https://google.github.io/eng-practices/review/reviewer/); [Conventional Comments](https://conventionalcomments.org/)
- ISTQB — [Certified Tester Foundation Level v4](https://www.istqb.org/certifications/certified-tester-foundation-level-ctfl-v4-0/); James Bach — [Heuristic Test Strategy Model](https://www.satisfice.com/download/heuristic-test-strategy-model); Elisabeth Hendrickson — Test Heuristics Cheat Sheet
- Andreas Zeller — [The Debugging Book](https://www.debuggingbook.org/)
- Matt Wynne — [Example Mapping](https://cucumber.io/blog/bdd/example-mapping-introduction/); Bill Wake — [INVEST](https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/); [ISO/IEC 25010](https://iso25000.com/index.php/en/iso-25000-standards/iso-25010)
- Michael Nygard — [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions); [C4 model](https://c4model.com/)
- [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD); MetaGPT ([paper](https://arxiv.org/abs/2308.00352)); ChatDev ([paper](https://arxiv.org/abs/2307.07924)); [CrewAI](https://docs.crewai.com/)
