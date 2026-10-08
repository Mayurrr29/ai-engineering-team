import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApi, TOKENS } from './helpers.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

test('GET /users/me returns the public profile only', async () => {
  const res = await api.request('GET', '/users/me', { token: TOKENS.sam });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { id: 4, name: 'Sam Student', email: 'sam@learnhub.dev', role: 'student' });
});

test('GET /users/me requires authentication', async () => {
  const res = await api.request('GET', '/users/me');
  assert.equal(res.status, 401);
});

test('users can read their own record but not other users', async () => {
  assert.equal((await api.request('GET', '/users/4', { token: TOKENS.sam })).status, 200);
  assert.equal((await api.request('GET', '/users/5', { token: TOKENS.sam })).status, 403);
});

test('admins can read any user; unknown ids are 404', async () => {
  assert.equal((await api.request('GET', '/users/5', { token: TOKENS.admin })).status, 200);
  assert.equal((await api.request('GET', '/users/9999', { token: TOKENS.admin })).status, 404);
});
