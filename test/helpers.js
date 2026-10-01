import { createServer } from 'node:http';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

// Servidor en memoria. `client()` devuelve un cliente HTTP con su propio cookie jar (una sesión).
export async function start() {
  const db = openDb(':memory:');
  const server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null), setCookie: set };
    };
    return { call, hasCookie: () => !!cookie };
  };
  // Cliente con el primer administrador ya creado y la sesión iniciada.
  const admin = client();
  await admin.call('POST', '/api/auth/setup', { username: 'admin', name: 'Admin', password: 'clave-segura-1' });
  return { db, base, client, admin: admin.call, close: () => server.close() };
}
