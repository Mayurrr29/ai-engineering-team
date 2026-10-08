# Team Rulebook

Every member of the AI engineering team reads this rulebook before working. {{reviewer}} and {{security}} enforce it. Edit any part of it; the team keeps your edits.

## Core rules

1. **Secrets stay secret.** They come from environment variables or a secret store — never from source code, logs or API responses.
2. **Authentication is never weakened or bypassed.**
3. **Every entry point validates its input on the server**: type, required fields, length and range limits, format.
4. **Every protected operation checks authorization**, including ownership of the specific resource.
5. **Responses expose only intended fields.** Never return password hashes, tokens or internal flags.
6. **Limits are enforced atomically.** Counters, stock, redemptions and balances use a single conditional update or a transaction, never read-then-write.
7. **Reuse before you write.** Use existing helpers and patterns; don't duplicate business logic.
8. **Stay in scope.** Don't modify unrelated files or add unrequested features.
9. **New dependencies need a reason** recorded in the change notes.
10. **Every bug fix comes with a regression test**, and tests are never weakened to make code pass.
11. **Existing behavior keeps working**: lint, typecheck, tests and build pass.
12. **No debug leftovers** in production code: no stray `console.log`, commented-out code or temporary files.

## Project rules

Written by {{lead}} during onboarding from what this codebase actually does. Run `ai-team onboard` to refresh them.

<!-- ai-team:project-rules:start -->
_Not generated yet — run `ai-team onboard`._
<!-- ai-team:project-rules:end -->

## Learned rules

Added by {{lead}} after missions, from what the team learned. Each has an id; you can edit or delete any of them.

<!-- ai-team:learned:start -->
<!-- ai-team:learned:end -->
