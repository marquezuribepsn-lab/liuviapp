import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // Respuesta sin interpretar (descargas binarias y encabezados).
    const raw = async (method, path) => {
      const res = await fetch(base + path, { method, headers: cookie ? { Cookie: cookie } : {} });
      return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    };
    return { call, raw, hasCookie: () => !!cookie };
  };
  // Cliente con el primer administrador ya creado y la sesión iniciada.
  const admin = client();
  await admin.call('POST', '/api/auth/setup', { username: 'admin', name: 'Admin', password: 'clave-segura-1' });
  return { db, base, client, admin: admin.call, adminRaw: admin.raw, close: () => server.close() };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const freePort = () => new Promise((res) => { const s = createNetServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// Copia del programa en otra carpeta (como un ZIP recién extraído), opcionalmente con otra versión.
export function copyProgram(dest, { version } = {}) {
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(ROOT)) if (/\.js$/.test(f) || f === 'package.json') cpSync(join(ROOT, f), join(dest, f));
  cpSync(join(ROOT, 'public'), join(dest, 'public'), { recursive: true });
  if (version) {
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ ...pkg, version }));
  }
}

// Arranca server.js de una copia del programa. Devuelve la salida, el puerto y cómo cerrarlo.
export function launch(programDir, env = {}, port) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: programDir, env: { ...process.env, PORT: String(port), DB_PATH: '', ...env } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', r));
  return { out: () => out, port, base: `http://127.0.0.1:${port}`, exited, kill: (sig = 'SIGKILL') => { child.kill(sig); return exited; } };
}
export async function runServer(programDir, env) {
  const srv = launch(programDir, env, await freePort());
  for (let i = 0; i < 100 && !srv.out().includes('listo'); i++) await new Promise((r) => setTimeout(r, 50));
  if (!srv.out().includes('listo')) throw new Error('el servidor no arrancó: ' + srv.out());
  return { ...srv, me: async () => (await (await fetch(srv.base + '/api/auth/me')).json()).setupNeeded };
}
