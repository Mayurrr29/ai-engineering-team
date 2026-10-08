# LearnHub API

Course marketplace API: instructors publish courses, students buy them.

- **Stack:** Node.js 20+, Express 5, an in-memory MongoDB stand-in (`src/db.js`, same API as the official driver).
- **Run:** `npm start` (port 3000, seeded data) · **Test:** `npm test` (`node:test`).

## Conventions

- Routes live in `src/routes/*.js` and are mounted in `src/app.js`.
- Authentication: `requireAuth` (Bearer token → `req.user`), authorization: `requireRole(...)` (`src/auth.js`).
- Every request body goes through `validate(body, schema)` (`src/validate.js`). It returns only the declared fields.
- Errors are thrown as `HttpError(status, message)` (`src/errors.js`); Express 5 forwards async errors to the error handler.
- Success responses are `{ data: ... }`; errors are `{ error: message, details? }`.
- Users leave the API only through `publicUser()` (`src/serializers.js`). Never return a raw user document.
- Money is stored in integer cents.

## Seed data (`src/seed.js`)

| id | name | role | token |
|---|---|---|---|
| 1 | Ada Admin | admin | `tok-admin-7f3a91` |
| 2 | Ira Instructor | instructor | `tok-ira-91c2d4` |
| 3 | Omar Instructor | instructor | `tok-omar-5d8e2b` |
| 4 | Sam Student | student | `tok-sam-2b6f0c` |
| 5 | Sara Student | student | `tok-sara-c4a1e9` |

Plus 150 students named `Learner 001`…`Learner 150`. Courses: 1 "Node.js Fundamentals" (5000, Ira, published), 2 "React in Depth" (8000, Omar, published), 3 "Advanced Node (draft)" (9000, Ira, unpublished).
