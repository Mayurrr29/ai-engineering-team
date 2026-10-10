import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { assertNot500, db, startApi, TOKENS } from './_api.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

// 45 orders, ids 1..45, oldest first.
beforeEach(async () => {
  api.resetDb();
  for (let i = 0; i < 45; i++) await db.orders.insertOne({ userId: 6 + i, courseId: 1 + (i % 2), amount: 5000, createdAt: new Date(2026, 0, 1 + i).toISOString() });
});

const list = (query) => api.request('GET', `/admin/orders${query}`, { token: TOKENS.admin });
const ids = (res) => res.body.data.map((o) => o.id);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('page 1 starts with the oldest orders', async () => {
  const res = await list('?page=1&limit=20');
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), range(1, 20));
});

test('the default request returns the first page', async () => {
  const res = await list('');
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), range(1, 20));
});

test('consecutive pages neither overlap nor skip orders', async () => {
  const seen = [];
  for (const page of [1, 2, 3]) seen.push(...ids(await list(`?page=${page}&limit=20`)));
  assert.deepEqual(seen, range(1, 45));
});

test('a page past the end is empty, not an error', async () => {
  const res = await list('?page=9&limit=20');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});

test('the response keeps its shape and reports the total', async () => {
  const res = await list('?page=2&limit=10');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 45);
  assert.equal(res.body.page, 2);
  assert.equal(res.body.limit, 10);
  assert.deepEqual(ids(res), range(11, 20));
});

for (const limit of ['0', '-5', 'abc', '100000', '2.5']) {
  test(`limit=${limit} can't dump the table or crash`, async () => {
    const res = await list(`?page=1&limit=${limit}`);
    assertNot500(res);
    if (res.status === 200) assert.ok(res.body.data.length >= 1 && res.body.data.length <= 100, `returned ${res.body.data.length} orders`);
    else assert.equal(res.status, 400);
  });
}

for (const page of ['0', '-1', 'abc', '1.5']) {
  test(`page=${page} is rejected or treated as a valid page`, async () => {
    const res = await list(`?page=${page}&limit=20`);
    assertNot500(res);
    if (res.status === 200) assert.deepEqual(ids(res), range(1, 20));
    else assert.equal(res.status, 400);
  });
}

test('non-admins still cannot list orders', async () => {
  assert.equal((await api.request('GET', '/admin/orders', { token: TOKENS.sam })).status, 403);
});
