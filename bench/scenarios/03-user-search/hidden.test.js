import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assertNot500, assertStatusIn, startApi, TOKENS } from './_api.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

const search = (query, token = TOKENS.admin) => api.request('GET', `/users?${query}`, { token });
const ids = (res) => (res.body?.data ?? []).map((u) => u.id);

test('admin finds users by name', async () => {
  const res = await search('search=Sara');
  assertStatusIn(res, [200]);
  assert.ok(ids(res).includes(5));
});

test('search matches email too', async () => {
  const res = await search('search=learnhub.dev&limit=50');
  assertStatusIn(res, [200]);
  assert.deepEqual([...ids(res)].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(res.body.total, 5);
});

test('total reflects every match, not just the page', async () => {
  const res = await search('search=Learner%2000&limit=5');
  assertStatusIn(res, [200]);
  assert.equal(res.body.total, 9);
  assert.ok(res.body.data.length <= 5);
});

test('pagination returns distinct pages', async () => {
  const p1 = await search('search=Learner&limit=10&page=1');
  const p2 = await search('search=Learner&limit=10&page=2');
  assertStatusIn(p1, [200]);
  assertStatusIn(p2, [200]);
  assert.equal(p1.body.data.length, 10);
  assert.equal(p2.body.data.length, 10);
  assert.equal(ids(p1).filter((id) => ids(p2).includes(id)).length, 0);
  assert.equal(p1.body.total, 150);
});

test('non-admins are forbidden and anonymous users are unauthenticated', async () => {
  assertStatusIn(await search('search=Sara', TOKENS.sam), [403]);
  assertStatusIn(await api.request('GET', '/users?search=Sara'), [401]);
});

test('results never include password hashes', async () => {
  const res = await search('search=Learner&limit=20');
  assert.ok(!res.text.includes('passwordHash') && !res.text.includes('$2b$'), 'response leaked password hashes');
});

test('search text is treated literally, not as a regex', async () => {
  const wildcard = await search(`search=${encodeURIComponent('.*')}`);
  assertStatusIn(wildcard, [200]);
  assert.equal(wildcard.body.total, 0, '".*" must not match every user');
  const broken = await search(`search=${encodeURIComponent('(')}`);
  assertNot500(broken);
});

test('page size is capped', async () => {
  const res = await search('search=Learner&limit=1000');
  assertNot500(res);
  if (res.status === 200) assert.ok(res.body.data.length <= 100, `returned ${res.body.data.length} users in one page`);
  else assertStatusIn(res, [400, 422]);
});

test('invalid paging parameters never cause server errors', async () => {
  for (const query of ['page=0', 'page=-1', 'limit=0', 'limit=abc', 'page=abc', 'limit=-5']) {
    const res = await search(`search=Learner&${query}`);
    assertNot500(res);
    if (res.status === 200) assert.ok(Array.isArray(res.body.data) && res.body.data.length <= 100, query);
  }
});

test('repeated or missing search parameters never cause server errors', async () => {
  assertNot500(await search('search=a&search=b'));
  const none = await search('');
  assertNot500(none);
  if (none.status === 200) assert.ok(none.body.data.length <= 100);
});
