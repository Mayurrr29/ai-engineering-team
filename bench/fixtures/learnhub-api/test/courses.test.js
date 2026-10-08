import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApi, TOKENS } from './helpers.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

test('GET /courses lists published courses only', async () => {
  const res = await api.request('GET', '/courses');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((c) => c.id), [1, 2]);
});

test('GET /courses/:id returns 404 for drafts and unknown ids', async () => {
  assert.equal((await api.request('GET', '/courses/3')).status, 404);
  assert.equal((await api.request('GET', '/courses/999')).status, 404);
});

test('instructors can create courses', async () => {
  const res = await api.request('POST', '/courses', { token: TOKENS.ira, body: { title: 'Testing Node', price: 3000 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.instructorId, 2);
  assert.equal(res.body.data.published, false);
});

test('students cannot create courses', async () => {
  const res = await api.request('POST', '/courses', { token: TOKENS.sam, body: { title: 'Nope', price: 1 } });
  assert.equal(res.status, 403);
});

test('course input is validated', async () => {
  const res = await api.request('POST', '/courses', { token: TOKENS.ira, body: { title: 'x', price: -1 } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});
