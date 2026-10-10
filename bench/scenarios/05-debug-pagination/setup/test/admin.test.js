import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApi, TOKENS } from './helpers.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

test('only admins can list all orders', async () => {
  assert.equal((await api.request('GET', '/admin/orders', { token: TOKENS.sam })).status, 403);
  assert.equal((await api.request('GET', '/admin/orders')).status, 401);
});

test('the admin order list has the documented shape', async () => {
  const res = await api.request('GET', '/admin/orders', { token: TOKENS.admin });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(typeof res.body.total, 'number');
});
