import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApi, TOKENS } from './_api.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

test('unknown routes use the new message', async () => {
  const res = await api.request('GET', '/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Resource not found' });
});

test('specific not-found messages are unchanged', async () => {
  assert.equal((await api.request('GET', '/courses/999')).body?.error, 'Course not found');
  assert.equal((await api.request('GET', '/users/9999', { token: TOKENS.admin })).body?.error, 'User not found');
});

test('other error responses are unchanged', async () => {
  const res = await api.request('POST', '/courses', { token: TOKENS.ira, rawBody: '{"title": ' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Malformed JSON body' });
});
