# Proving Ground results

Generated 2026-10-12 17:34 UTC. Hidden tests are never shown to the team; they check the traps described in [docs/research.md](../docs/research.md).

## Totals

| Contender | Hidden tests passed | Visible tests | AI cost | Tokens out · cache-write · cache-read | Calls | Wall time | Missions approved |
|---|---|---|---|---|---|---|---|
| **baseline-v0.2.2** | 56/56 (100%) | 118/118 | $4.36 (+$1.11 onboarding) | 139k · 622k · 2341k | 35 | 23.2 min | 5/5 |
| **baseline-v0.2.2-b** | 56/56 (100%) | 117/117 | $4.42 (+$1.09 onboarding) | 145k · 623k · 2276k | 36 | 25.9 min | 5/5 |
| **v0.3-mid** | 56/56 (100%) | 124/124 | $6.19 (+$1.00 onboarding) | 151k · 618k · 2813k | 38 | 23.9 min | 5/5 |
| **v0.3-final-a** | 56/56 (100%) | 115/115 | $3.98 (+$1.20 onboarding) | 117k · 587k · 2205k | 33 | 23.3 min | 5/5 |
| **solo-baseline** | 55/56 (98%) | 96/96 | $0.47 | 15k · 60k · 383k | 5 | 2.5 min | 5/5 |
| **solo-baseline-b** | 55/56 (98%) | 95/95 | $0.43 | 15k · 55k · 375k | 5 | 2.4 min | 5/5 |

## 01-profile-update

| Contender | Hidden | Status | Cost | Time | Rounds | Team | Hidden failures |
|---|---|---|---|---|---|---|---|
| baseline-v0.2.2 | 15/15 | approved | $0.94 | 4.8 min | 1 | dev + qa(l), security(l), reviewer(l) | — |
| baseline-v0.2.2-b | 15/15 | approved | $0.66 | 3.8 min | 1 | dev + security(l), reviewer(l) | — |
| v0.3-mid | 15/15 | approved | $0.80 | 3.6 min | 1 | dev + security(l), reviewer(l) | — |
| v0.3-final-a | 15/15 | approved | $0.81 | 4.5 min | 1 | dev + qa(l), security(l), reviewer(l) | — |
| solo-baseline | 14/15 | done | $0.10 | 0.5 min | - | solo agent | a crafted email cannot stall the server (ReDoS) |
| solo-baseline-b | 14/15 | done | $0.09 | 0.5 min | - | solo agent | a crafted email cannot stall the server (ReDoS) |

## 02-coupons

| Contender | Hidden | Status | Cost | Time | Rounds | Team | Hidden failures |
|---|---|---|---|---|---|---|---|
| baseline-v0.2.2 | 13/13 | approved | $2.24 | 10.3 min | 2 | dev + qa, security, reviewer | — |
| baseline-v0.2.2-b | 13/13 | approved | $2.43 | 13 min | 3 | dev + qa, security, reviewer | — |
| v0.3-mid | 13/13 | approved | $4.20 | 12.4 min | 3 | dev + qa, security, reviewer | — |
| v0.3-final-a | 13/13 | approved | $1.93 | 9.5 min | 2 | dev + pm, qa, security, reviewer | — |
| solo-baseline | 13/13 | done | $0.15 | 0.8 min | - | solo agent | — |
| solo-baseline-b | 13/13 | done | $0.14 | 0.8 min | - | solo agent | — |

## 03-user-search

| Contender | Hidden | Status | Cost | Time | Rounds | Team | Hidden failures |
|---|---|---|---|---|---|---|---|
| baseline-v0.2.2 | 10/10 | approved | $0.63 | 3.4 min | 0 | dev + qa(l), security(l), reviewer(l) | — |
| baseline-v0.2.2-b | 10/10 | approved | $0.68 | 3.9 min | 0 | dev + qa(l), security, reviewer(l) | — |
| v0.3-mid | 10/10 | approved | $0.62 | 3.4 min | 0 | dev + qa(l), security(l), reviewer(l) | — |
| v0.3-final-a | 10/10 | approved | $0.67 | 4.1 min | 0 | dev + qa(l), security(l), reviewer(l) | — |
| solo-baseline | 10/10 | done | $0.10 | 0.5 min | - | solo agent | — |
| solo-baseline-b | 10/10 | done | $0.09 | 0.4 min | - | solo agent | — |

## 04-tiny-change

| Contender | Hidden | Status | Cost | Time | Rounds | Team | Hidden failures |
|---|---|---|---|---|---|---|---|
| baseline-v0.2.2 | 3/3 | approved | $0.12 | 1.8 min | 0 | dev solo | — |
| baseline-v0.2.2-b | 3/3 | approved | $0.13 | 1.8 min | 0 | dev solo | — |
| v0.3-mid | 3/3 | approved | $0.13 | 1.6 min | 0 | dev solo | — |
| v0.3-final-a | 3/3 | approved | $0.13 | 2 min | 0 | dev solo | — |
| solo-baseline | 3/3 | done | $0.03 | 0.3 min | - | solo agent | — |
| solo-baseline-b | 3/3 | done | $0.02 | 0.2 min | - | solo agent | — |

## 05-debug-pagination

| Contender | Hidden | Status | Cost | Time | Rounds | Team | Hidden failures |
|---|---|---|---|---|---|---|---|
| baseline-v0.2.2 | 15/15 | approved | $0.43 | 2.9 min | 0 | dev + security(l), reviewer(l) | — |
| baseline-v0.2.2-b | 15/15 | approved | $0.52 | 3.4 min | 0 | dev + qa(l), security(l), reviewer(l) | — |
| v0.3-mid | 15/15 | approved | $0.44 | 2.9 min | 0 | dev + security(l), reviewer(l) | — |
| v0.3-final-a | 15/15 | approved | $0.44 | 3.2 min | 0 | dev + security(l), reviewer(l) | — |
| solo-baseline | 15/15 | done | $0.09 | 0.4 min | - | solo agent | — |
| solo-baseline-b | 15/15 | done | $0.09 | 0.5 min | - | solo agent | — |
