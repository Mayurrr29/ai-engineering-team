import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApi, TOKENS } from './helpers.js';

let api;
before(async () => (api = await startApi()));
after(() => api.close());

test('unknown routes return a JSON 404', async () => {
  const res = await api.request('GET', '/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Resource not found' });
});

test('malformed JSON bodies are rejected with 400', async () => {
  const res = await fetch(`${api.base}/courses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.ira}` },
    body: '{"title": ',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Malformed JSON body' });
});
