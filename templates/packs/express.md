---
id: express
title: Node.js + Express
---

## @all
- Express 5 forwards rejected promises from async handlers and middleware to the error handler; Express 4 does not (it needs a wrapper such as `asyncHandler`, or errors become unhandled rejections). Check which major version `package.json` uses before relying on either behavior.
- `req.query` parsing differs: Express 4 parses `?a[b]=1` into nested objects (via `qs`); Express 5's default parser does not, but repeated keys (`?a=1&a=2`) still produce arrays. Never assume a query value is a string.
- Middleware order matters: body parsers before routes, auth before handlers, the 404 handler after all routes, and the error handler (4 arguments) last.

## @developer
- Validate `req.body`, `req.query` and `req.params` at the route, with the project's validator, before using them. Convert numeric ids explicitly and reject non-numeric ones with a 400.
- Put protected routes behind the project's auth middleware, and check ownership in the handler for any resource fetched by id.
- Use `res.status(code).json(...)` with the project's response shape; don't mix shapes across endpoints.
- Don't leak stack traces: let unexpected errors reach the global error handler.

## @qa
- Easiest way to test an Express app in-process: `const server = createApp().listen(0)`, read the port from `server.address().port`, use `fetch`, and close the server afterwards. Look for an existing test helper first.
- Try: missing/invalid `Authorization` header; ids that are non-numeric, negative or huge; query params repeated (`?x=1&x=2`); bodies with extra fields; malformed JSON; very large bodies.

## @security
- Body size limits configured (`express.json({ limit })`)?
- CORS: no wildcard origin together with credentials; origins taken from an allowlist.
- `helmet` or equivalent headers if the project serves browsers; `x-powered-by` disabled.
- Rate limiting on authentication and expensive endpoints, if the project has a rate-limit mechanism.
- Open redirects: `res.redirect(req.query.next)` without an allowlist.

## @reviewer
- Async handlers in Express 4 without the project's wrapper are a bug (unhandled rejection, hanging request).
- Route ordering bugs: a parameterized route (`/users/:id`) registered before a static one (`/users/me`) shadows it.
