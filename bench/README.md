# Proving Ground

A small, realistic codebase and a set of missions with **hidden tests**, used to measure whether changes to the team actually make it better — or just more expensive.

- **Fixture:** `fixtures/learnhub-api` — an Express 5 course-marketplace API with an in-memory MongoDB stand-in (`src/db.js` mirrors the driver: query/update operators, unique indexes that throw E11000, async operations with real race windows). It has conventions a good team should follow: `validate()`, `HttpError`, `publicUser()`, `{ data }` responses.
- **Scenarios:** `scenarios/NN-name/task.md` is the request given to the team; `hidden.test.js` scores the final code and is copied in only after the mission ends. `reference/` holds a solution used to prove the hidden tests are fair.

| Scenario | Size | Traps |
|---|---|---|
| 01 profile update | M | IDOR, mass assignment, validation, duplicate email, NoSQL operator injection, password-hash leaks, ReDoS in the email check |
| 02 coupons | L | ownership, percent validation, course scoping, expiry, `maxRedemptions` under concurrent orders, operator injection |
| 03 user search | M | admin-only, regex injection, page-size cap, invalid paging, totals, data leaks |
| 04 tiny change | XS | exact change, nothing else broken — and cost |

## Running

```bash
node bench/run.mjs --reference                                        # hidden tests fail on the base app, pass on references
node bench/run.mjs --cli dist/cli.js --label my-version --parallel 4  # run ai-team on every scenario
node bench/run.mjs --solo --label solo-claude-code                    # baseline: one plain Claude Code agent
node bench/run.mjs --rescore --label my-version                       # re-score kept work dirs after hidden tests change
node bench/compare.mjs                                                # writes bench/RESULTS.md
```

Work directories are kept in `bench/.runs/<label>/<scenario>` (git-ignored) for inspection; results go to `bench/results/<label>/*.json`. Runs use your Claude Code login and cost real usage.

Scores from a single run per scenario are noisy; treat small differences with caution.
