# Project Engineering Rules

Every agent on the AI team reads this file before doing anything. Edit it to match your project — these rules are enforced by the Code Reviewer and the Security Reviewer.

1. Never expose secrets. Secrets come from environment variables, never from source code, logs or API responses.
2. Never bypass or weaken authentication.
3. Every API endpoint validates its input on the server.
4. Every protected endpoint verifies authorization, including ownership of the resource being accessed.
5. Don't duplicate business logic; reuse existing services/helpers.
6. Don't modify unrelated files.
7. Don't introduce new dependencies without justification.
8. Every bug fix comes with a regression test.
9. Every UI feature handles loading, error and empty states.
10. Existing functionality must not break: lint, typecheck, tests and build must pass.
11. New database queries are checked for performance (indexes, pagination, N+1).
12. Production code contains no `console.log` / debug code / commented-out code.

<!-- Add project-specific rules below, e.g.:
13. All API responses use the shape { success, data, error }.
14. All Mongo queries on soft-deletable models filter `deletedAt: null`.
-->
