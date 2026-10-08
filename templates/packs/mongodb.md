---
id: mongodb
title: MongoDB / Mongoose
---

## @all
- **Operator injection.** If a request value can be an object, `{ email: req.body.email }` becomes `{ email: { $ne: null } }` and matches any document. Validate every value used in a filter as the expected primitive type (string, number) before querying. Mongoose's `sanitizeFilter` or schema casting helps only where it's actually enabled.
- **Atomic updates.** Limits and counters (stock, redemptions, balances, seats) must be enforced in one conditional update, e.g. `findOneAndUpdate({ _id, remaining: { $gt: 0 } }, { $inc: { remaining: -1 } })`. Reading the document, checking in JavaScript and then writing is a race: two concurrent requests both pass the check.
- **Duplicate keys.** Unique indexes throw error code `11000` (E11000). Catch it and return a 409 or 400 instead of letting it become a 500.

## @architect
- Add indexes for new query patterns (filter + sort fields), and unique indexes for uniqueness rules — uniqueness checked only in application code is racy.
- Prefer embedding for data read together and owned by one parent; reference for shared or unbounded data.
- Multi-document invariants need a transaction (replica set) or a design that keeps the invariant in one document.

## @developer
- Use `$set` with an explicit allowlist of fields, never `{ $set: req.body }` (mass assignment).
- Escape user input before using it in `$regex` (`text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`), and cap its length.
- Use projections or the project's serializer so password hashes and internal fields never leave the API.
- Paginate with `skip`/`limit` (or a range on an indexed field) and cap `limit`.

## @qa
- Send `{"$ne": null}`, `{"$gt": ""}` and `{"$regex": ".*"}` where strings are expected (body fields and, in Express 4, `?field[$ne]=x` query params).
- Fire concurrent requests at anything with a limit, and check the limit in the stored data afterwards.
- Try to create duplicates of anything that should be unique; expect a clean 4xx, never a 500.

## @security
- Look for `$where`, `$function`, `$accumulator` or `mapReduce` with user input (server-side JavaScript execution).
- User-controlled field names in filters or sort (`{ [req.query.sortBy]: 1 }`) allow probing of hidden fields.
- Check that `select: false` or projections protect sensitive fields on every query that returns users.

## @reviewer
- Read-then-write on counters is a correctness bug, not a style issue.
- Missing index for a new query on a large collection is a performance finding.
