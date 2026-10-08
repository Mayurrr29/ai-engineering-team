import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApi, TOKENS } from './helpers.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

test('students can buy a published course at full price', async () => {
  const res = await api.request('POST', '/orders', { token: TOKENS.sam, body: { courseId: 1 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.amount, 5000);
});

test('buying the same course twice is rejected', async () => {
  const res = await api.request('POST', '/orders', { token: TOKENS.sam, body: { courseId: 1 } });
  assert.equal(res.status, 409);
});

test('draft courses cannot be bought', async () => {
  const res = await api.request('POST', '/orders', { token: TOKENS.sara, body: { courseId: 3 } });
  assert.equal(res.status, 404);
});

test('only students can place orders', async () => {
  const res = await api.request('POST', '/orders', { token: TOKENS.ira, body: { courseId: 2 } });
  assert.equal(res.status, 403);
});
