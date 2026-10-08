// Shared helper for hidden tests. Copied next to the hidden tests as _api.js.
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { resetDb, TOKENS } from '../src/seed.js';

export { db, TOKENS };

export async function startApi() {
  process.env.NODE_ENV = 'test';
  resetDb();
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { token, body, rawBody } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text };
  }

  return { base, request, resetDb, close: () => new Promise((resolve) => server.close(resolve)) };
}

export function assertStatusIn(res, allowed, message = '') {
  assert.ok(allowed.includes(res.status), `expected status in [${allowed}], got ${res.status} ${message} ${res.text.slice(0, 200)}`);
}

export function assertNot500(res) {
  assert.ok(res.status < 500, `server error ${res.status}: ${res.text.slice(0, 200)}`);
}

export const unique = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
