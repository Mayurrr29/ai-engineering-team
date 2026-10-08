import assert from 'node:assert/strict';
import { after, beforeEach, before, test } from 'node:test';
import { assertNot500, assertStatusIn, db, startApi, TOKENS } from './_api.js';

let api;
before(async () => (api = await startApi()));
beforeEach(() => api.resetDb());
after(() => api.close());

const patch = (id, body, token = TOKENS.sam) => api.request('PATCH', `/users/${id}`, { token, body });
const user = (id) => db.users.findOne({ id });

test('owner can update their own name', async () => {
  const res = await patch(4, { name: 'Sam Updated' });
  assertStatusIn(res, [200]);
  assert.equal(res.body?.data?.name, 'Sam Updated');
  assert.equal((await user(4)).name, 'Sam Updated');
});

test('owner can update their own email', async () => {
  const res = await patch(4, { email: 'sam.new@learnhub.dev' });
  assertStatusIn(res, [200]);
  assert.equal((await user(4)).email, 'sam.new@learnhub.dev');
});

test('admin can update another user', async () => {
  const res = await patch(5, { name: 'Sara Renamed' }, TOKENS.admin);
  assertStatusIn(res, [200]);
  assert.equal((await user(5)).name, 'Sara Renamed');
});

test('unauthenticated requests are rejected', async () => {
  const res = await api.request('PATCH', '/users/4', { body: { name: 'Anon' } });
  assertStatusIn(res, [401]);
  assert.equal((await user(4)).name, 'Sam Student');
});

test('a user cannot update another user (IDOR)', async () => {
  const res = await patch(5, { name: 'Hacked' });
  assertStatusIn(res, [403, 404]);
  assert.equal((await user(5)).name, 'Sara Student');
});

test('a user cannot make themselves admin (mass assignment)', async () => {
  const res = await patch(4, { name: 'Sam', role: 'admin' });
  assertNot500(res);
  assert.equal((await user(4)).role, 'student');
});

test('protected fields (passwordHash, id) cannot be overwritten', async () => {
  const before = await user(4);
  const res = await patch(4, { passwordHash: 'pwned', id: 999 });
  assertNot500(res);
  const after = await user(4);
  assert.ok(after, 'user 4 must still exist under id 4');
  assert.equal(after.passwordHash, before.passwordHash);
  assert.equal(await db.users.findOne({ id: 999 }), null);
});

test('invalid email is rejected', async () => {
  const res = await patch(4, { email: 'not-an-email' });
  assertStatusIn(res, [400, 422]);
  assert.equal((await user(4)).email, 'sam@learnhub.dev');
});

test('blank name is rejected', async () => {
  const res = await patch(4, { name: '   ' });
  assertStatusIn(res, [400, 422]);
  assert.equal((await user(4)).name, 'Sam Student');
});

test('absurdly long name is rejected', async () => {
  const res = await patch(4, { name: 'x'.repeat(5000) });
  assertStatusIn(res, [400, 413, 422]);
  assert.equal((await user(4)).name, 'Sam Student');
});

test('email already used by another account is rejected cleanly', async () => {
  const res = await patch(4, { email: 'sara@learnhub.dev' });
  assertStatusIn(res, [400, 409, 422]);
  assert.equal((await user(4)).email, 'sam@learnhub.dev');
});

test('non-string values are rejected (type / NoSQL operator injection)', async () => {
  const injected = await patch(4, { email: { $ne: null } });
  assertStatusIn(injected, [400, 422]);
  const numeric = await patch(4, { name: 12345 });
  assertStatusIn(numeric, [400, 422]);
  const after = await user(4);
  assert.equal(after.email, 'sam@learnhub.dev');
  assert.equal(after.name, 'Sam Student');
});

test('response never exposes the password hash', async () => {
  const res = await patch(4, { name: 'Sam Safe' });
  assert.ok(!res.text.includes('passwordHash') && !res.text.includes('$2b$'), `response leaked sensitive fields: ${res.text}`);
});

test('unknown and malformed ids are handled without server errors', async () => {
  assertStatusIn(await patch(9999, { name: 'Ghost' }, TOKENS.admin), [404]);
  const malformed = await patch('abc', { name: 'Ghost' }, TOKENS.admin);
  assertStatusIn(malformed, [400, 404]);
});

test('a crafted email cannot stall the server (ReDoS)', async () => {
  const email = `a@${'a.'.repeat(40000)}@`;
  const started = Date.now();
  const res = await patch(4, { email });
  const elapsed = Date.now() - started;
  assertStatusIn(res, [400, 413, 422]);
  assert.ok(elapsed < 1000, `request took ${elapsed} ms — the email check backtracks catastrophically`);
  assert.equal((await user(4)).email, 'sam@learnhub.dev');
});
