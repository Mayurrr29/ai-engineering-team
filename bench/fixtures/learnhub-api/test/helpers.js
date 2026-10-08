import { createApp } from '../src/app.js';
import { resetDb, TOKENS } from '../src/seed.js';

export { TOKENS };

/** Starts the app on a random port with a freshly seeded database. */
export async function startApi() {
  process.env.NODE_ENV = 'test';
  resetDb();
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { token, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text };
  }

  return { base, request, close: () => new Promise((resolve) => server.close(resolve)) };
}
