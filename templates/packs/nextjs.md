---
id: nextjs
title: Next.js
---

## @all
- Know which router the project uses: App Router (`app/`) or Pages Router (`pages/`). Follow it; don't mix patterns.
- Server Components, Route Handlers and Server Actions run on the server; anything marked `'use client'` ships to the browser.

## @developer
- Server Actions and Route Handlers are public HTTP endpoints: authenticate and authorize inside each one, and validate their input, even if the UI only calls them from protected pages.
- Never import server-only modules (database clients, secrets) into client components; use the `server-only` package if the project does.
- Use the project's caching and revalidation approach (`revalidatePath`, `revalidateTag`, `cache: 'no-store'`) deliberately when data changes.

## @qa
- Test the Server Action or Route Handler directly (as an HTTP request), not only through the UI.
- Check behavior with JavaScript disabled for forms that use Server Actions, if progressive enhancement matters to the project.

## @security
- Only `NEXT_PUBLIC_*` env variables reach the browser; make sure no secret uses that prefix.
- Middleware-only auth checks can be bypassed if the matcher misses a path; verify auth in the handler too.
- Check redirects and `next/image` remote patterns for open redirect / SSRF exposure.

## @reviewer
- Data fetching in client components that could be done in a Server Component; unnecessary `'use client'` boundaries.
