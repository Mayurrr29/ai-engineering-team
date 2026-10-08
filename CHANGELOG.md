# Changelog

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
