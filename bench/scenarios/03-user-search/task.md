Add an admin-only user search: `GET /users?search=<text>&page=<n>&limit=<n>` returns users whose name or email contains the search text, as `{ data: users, page, limit, total }`.
