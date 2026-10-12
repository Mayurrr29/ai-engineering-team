# Changelog

## 0.3.0

The team adapts to the task, tells the truth about "done", and spends less on loops. See `docs/architecture.md` for the audit and the measurements behind each change.

- **Not every request is a build.** JARVIS classifies questions (answered with evidence, usually in one call, nothing changed, no tests run), planning requests (DATA writes decisions and milestones; nothing built) and bug reports (FRIDAY works in debugging mode: reproduce, confirm the root cause, fix, prove).
- **Done means done.** HAL now fails a mission when the developer reported an acceptance criterion as partial or not done, when a surface JARVIS planned (frontend, tests, docs) wasn't touched, when a build changed no code, or when a blocker is still open. The orchestrator sends such work back before it is tested or reviewed. Bug fixes without a test change get a warning.
- **Read-only really means read-only.** QA has a shell, so the write hook alone couldn't stop edits made through it. After every read-only member's turn the orchestrator compares the working tree with a snapshot (a git tree written through a throwaway index — your index and files are untouched) and restores anything they changed.
- **Signals: the team talks.** Any member can raise a concern, an assumption, a recruit request (adds a member), a blocker (goes to JARVIS) or a question for the human (asked once; an answer that differs from the default reopens the work). Each member's prompt gets only the entries meant for them.
- **The team can grow mid-mission**, and an approval that still covers the current code is not re-run.
- **Cheaper loops.** FRIDAY fixes QA's findings in her own resumed session; BAYMAX takes over with fresh eyes when JARVIS asks for a different approach (`loop.fixer`). Rework resumes her session too. Re-tests and re-reviews get only the change since the member last looked.
- **Leaner calls.** JARVIS's prompt carries only the mode he is in; tool-less calls skip the Claude Code preset; the AI debrief runs only when there is something to learn; EVE keeps passing scenarios to one line; JARVIS's key files reach FRIDAY.
- **Output that fits the task.** Answers print in the terminal; solo approvals are one line; the HTML report opens for team missions and plans.
- **Fixes:** a resumed session's cumulative cost is no longer double-counted; agents launched from inside Claude Code no longer share the parent's session id; baseline checks run after planning.
- **Measurement:** every call records its tokens; the Proving Ground saves per-call data, supports `setup/` overlays, and has a new debugging scenario (`05-debug-pagination`).
- Schema additions (custom providers must return them): `MissionPlan.answer`, `MissionPlan.taskType` `question`/`planning`, `DesignOutput.milestones`, `DevOutput.rootCause`, and `signals` on developer, fix, QA and review outputs. New run statuses `answered` and `planned`.

## 0.2.0

The team gets a lead, names, research-based playbooks, its own rules, and a face.

- **JARVIS, the team lead.** Sizes every mission (XS → XL), assesses risk, staffs only the members it needs, sets each member's effort, and writes a brief for each. Tiny tasks go to the developer alone.
- **The team:** JARVIS (lead), VISION (PM), DATA (architect, new), FRIDAY (developer), EVE (QA), BAYMAX (bug fixer, on call), EDITH (security), TARS (code review), and HAL 9000 (the deterministic release gate). Names are configurable.
- **Research-based playbooks** for every member, built from Anthropic's multi-agent and prompting guidance, OWASP Top 10:2025 / API Top 10:2023, STRIDE, ISTQB test design, Google's code review practices, ADRs and more. See `docs/research.md`.
- **Stack packs** (Express, MongoDB, React, Next.js, NestJS, SQL/ORMs, Python web) switch on automatically.
- **Onboarding:** `ai-team init` / `ai-team onboard` — JARVIS studies the repository and writes the project profile, project-specific rules with evidence, and notes for every teammate.
- **Learned rules:** after each mission JARVIS adds, updates or retires rules in the rulebook.
- **Guardrails in code** that can only add reviewers: diff size, security-sensitive files and APIs, dependency changes.
- **Budgets:** `--budget <usd>`; the mission pauses (resumable) instead of overspending. Per-member cost history improves JARVIS's estimates.
- **Arbitration:** recurring or disputed problems go to JARVIS (fix differently / waive MEDIUM-LOW / escalate to you).
- **Parallel reviews:** EDITH and TARS review at the same time; one rework round addresses both.
- **Baseline checks:** failures that existed before the mission aren't blamed on the team (but more failures than before still block).
- **Write limits enforced by code** via a PreToolUse hook: read-only members can't edit, EVE writes only in her lab, nobody touches `.ai-team/` or `.git/`.
- **Automated security scan leads** (secrets, injection, mass assignment, weak crypto…) for EDITH and TARS to verify.
- **Visuals:** live Mission Control panel in the terminal; an HTML Mission Report (traceability, bug journeys, timeline, war room, cost); Mermaid diagrams in artifacts.
- **Proving Ground** benchmark with hidden tests and a single-agent baseline (`bench/`).
- New commands: `onboard`, `report`, `team`. Config gains `mode: auto`, `budgetUsd`, `effort`, `team.names`, `guardrails`, `rules`, `ui`, `baselineChecks`. v0.1 `mode: "standard"` maps to `"full"`.

## 0.1.x

First release: PM → Developer → QA → Bug Fixer → Security → Code Review → deterministic release gate, on the Claude Agent SDK.
