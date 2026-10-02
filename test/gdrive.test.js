import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { start } from './helpers.js';
import { fakeGoogle } from './fakegoogle.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stateOf = (url) => new URL(url).searchParams.get('state');

test('Google Drive: conectar, subir cada copia a la carpeta de la PC, limpiar y desconectar', async () => {
  const g = await fakeGoogle();
  const t = await start({ google: { base: g.base, keep: 2 } });
  const dir = mkdtempSync(join(tmpdir(), 'liuvi-gd-'));
  try {
    await t.admin('PUT', '/api/backup', { dir, pc_name: 'Caja 1' });
    // Sin credenciales no se puede conectar; las credenciales se validan
    assert.equal((await t.admin('POST', '/api/backup/google/start', {})).status, 400);
    assert.equal((await t.admin('PUT', '/api/backup/google/credentials', { client_id: 'mal', client_secret: 'sec' })).status, 400);
    const cred = await t.admin('PUT', '/api/backup/google/credentials', { client_id: 'abc-123.apps.googleusercontent.com', client_secret: 'sec' });
    assert.equal(cred.status, 200);
    assert.equal(cred.data.google.configured, true);
    assert.ok(!JSON.stringify(cred.data).includes('"sec"'), 'el secreto nunca vuelve al navegador');

    // Solo con permiso de copias
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('POST', '/api/backup/google/start', {})).status, 403);
    assert.equal((await ana.call('POST', '/api/backup/google/disconnect', {})).status, 403);

    // Inicio de conexión: PKCE + state; la URL no lleva el secreto
    const start1 = await t.admin('POST', '/api/backup/google/start', {});
    assert.equal(start1.status, 200);
    const u = new URL(start1.data.url);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(u.searchParams.get('scope').includes('drive.file'));
    assert.ok(!start1.data.url.includes('sec'));
    assert.equal(u.searchParams.get('redirect_uri'), `${t.base}/api/backup/google/callback`);

    // La vuelta de Google no trae cookie: un state inventado se rechaza
    const cb = (state, code = 'cod') => fetch(`${t.base}/api/backup/google/callback?state=${state}&code=${code}`).then((r) => r.text());
    assert.match(await cb('inventado'), /venció/);
    assert.equal((await t.admin('GET', '/api/backup')).data.google.connected, false);
    assert.match(await cb(stateOf(start1.data.url)), /Google Drive conectado/);
    assert.match(await cb(stateOf(start1.data.url)), /venció/, 'el state sirve una sola vez');
    let s = (await t.admin('GET', '/api/backup')).data.google;
    assert.equal(s.connected, true);
    assert.equal(s.email, 'dueña@gmail.com');
    assert.equal(s.folder, 'Liu Vi - Copias / Caja 1');

    // Cada copia se sube a Liu Vi - Copias / Caja 1 (las carpetas se crean una sola vez)
    for (let i = 0; i < 3; i++) { if (i) await wait(1100); assert.equal((await t.admin('POST', '/api/backup/run', {})).status, 200); }
    const folders = g.st.files.filter((f) => !f.name.endsWith('.db'));
    assert.deepEqual(folders.map((f) => f.name), ['Liu Vi - Copias', 'Caja 1']);
    const dbs = g.st.files.filter((f) => f.name.endsWith('.db'));
    assert.equal(dbs.length, 2, 'en Drive se conservan solo las últimas (keep=2)');
    assert.ok(dbs.every((f) => f.parents[0] === folders[1].id && f.size > 1000));
    s = (await t.admin('GET', '/api/backup')).data.google;
    assert.equal(s.error, null);
    assert.ok(s.last_at && s.last_name.startsWith('liuvi-backup-'));

    // La copia (local y en Drive) no lleva la conexión con Google
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.db'))) {
      const c = new DatabaseSync(join(dir, f), { readOnly: true });
      assert.equal(c.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'google%'").get().n, 0);
      c.close();
    }
    assert.ok(readdirSync(dir).length >= 3);

    // Cambiar las credenciales desconecta la cuenta anterior
    await t.admin('PUT', '/api/backup/google/credentials', { client_id: 'abc-123.apps.googleusercontent.com', client_secret: 'sec' });
    assert.equal((await t.admin('GET', '/api/backup')).data.google.connected, false);

    // Reconectar y desconectar (revoca en Google)
    const st2 = await t.admin('POST', '/api/backup/google/start', {});
    assert.match(await cb(stateOf(st2.data.url)), /conectado/);
    const out = await t.admin('POST', '/api/backup/google/disconnect', {});
    assert.equal(out.data.google.connected, false);
    assert.equal(g.st.revoked, 1);
    const left = t.db.prepare("SELECT key FROM settings WHERE key LIKE 'google%' AND value != ''").all().map((r) => r.key);
    assert.deepEqual(left.sort(), ['google_client_id', 'google_client_secret']);
  } finally { t.close(); g.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Google Drive: si Google revoca el permiso se avisa y la copia local se hace igual', async () => {
  const g = await fakeGoogle();
  g.st.expires = 30; // el token de acceso vence enseguida: cada subida pide uno nuevo
  const t = await start({ google: { base: g.base } });
  const dir = mkdtempSync(join(tmpdir(), 'liuvi-gd-'));
  try {
    await t.admin('PUT', '/api/backup', { dir });
    await t.admin('PUT', '/api/backup/google/credentials', { client_id: 'abc-123.apps.googleusercontent.com', client_secret: 'sec' });
    const s1 = await t.admin('POST', '/api/backup/google/start', {});
    await fetch(`${t.base}/api/backup/google/callback?state=${stateOf(s1.data.url)}&code=x`);
    g.st.badRefresh = true;
    const run = await t.admin('POST', '/api/backup/run', {});
    assert.equal(run.status, 200);
    assert.ok(readdirSync(dir).some((f) => f.endsWith('.db')), 'la copia local se hizo');
    assert.equal(run.data.google.connected, false);
    assert.match(run.data.google.error, /Volvé a conectar/);
    assert.equal(g.st.files.length, 0);
  } finally { t.close(); g.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sin elegir carpeta, cada computadora guarda las copias junto a su base de datos', async () => {
  const { openDb } = await import('../db.js');
  const { createBackups } = await import('../backup.js');
  const base = mkdtempSync(join(tmpdir(), 'liuvi-pc-'));
  const db = openDb(join(base, 'liuvi.db'));
  try {
    const b = createBackups(db, { defaultDir: join(base, 'copias') });
    assert.equal(b.status().dir, join(base, 'copias'));
    assert.equal(b.status().custom_dir, false);
    const file = b.run('manual');
    assert.ok(file.startsWith(join(base, 'copias')));
    assert.equal(b.status().files.length, 1);
    // elegir otra carpeta pisa la de la computadora; vaciarla vuelve a la de la computadora
    const otra = mkdtempSync(join(tmpdir(), 'liuvi-otra-'));
    b.configure({ dir: otra });
    assert.equal(b.status().dir, otra);
    b.configure({ dir: '' });
    assert.equal(b.status().dir, join(base, 'copias'));
    rmSync(otra, { recursive: true, force: true });
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});

test('credenciales: se importa el archivo de Google y la ventanita de conexión avisa y se cierra', async () => {
  const g = await fakeGoogle();
  const t = await start({ google: { base: g.base } });
  try {
    const json = (o) => JSON.stringify(o);
    assert.equal((await t.admin('PUT', '/api/backup/google/credentials', { json: 'no es json' })).status, 400);
    const web = await t.admin('PUT', '/api/backup/google/credentials', { json: json({ web: { client_id: 'a.apps.googleusercontent.com', client_secret: 's' } }) });
    assert.equal(web.status, 400); assert.match(web.data.error, /Aplicación de escritorio/);
    assert.equal((await t.admin('PUT', '/api/backup/google/credentials', { json: json({ installed: { client_id: 'abc.apps.googleusercontent.com' } }) })).status, 400, 'falta el secreto');
    const ok = await t.admin('PUT', '/api/backup/google/credentials', { json: json({ installed: { client_id: 'abc-1.apps.googleusercontent.com', client_secret: 'sec', project_id: 'liuvi' } }) });
    assert.equal(ok.status, 200); assert.equal(ok.data.google.configured, true);

    // Conexión en ventanita: el callback avisa a la pantalla principal y se cierra
    const st = (await t.admin('POST', '/api/backup/google/start', { popup: true })).data.url;
    const html = await fetch(`${t.base}/api/backup/google/callback?state=${stateOf(st)}&code=c`).then((r) => r.text());
    assert.match(html, /postMessage/); assert.match(html, /window\.close/); assert.match(html, /Ya podés cerrar esta ventana/);
    assert.equal((await t.admin('GET', '/api/backup')).data.google.connected, true);
    // Sin ventanita (misma pestaña) vuelve al sistema
    const st2 = (await t.admin('POST', '/api/backup/google/start', {})).data.url;
    const html2 = await fetch(`${t.base}/api/backup/google/callback?state=${stateOf(st2)}&code=c`).then((r) => r.text());
    assert.match(html2, /location\.replace/); assert.doesNotMatch(html2, /window\.close/);
    // El usuario no da el permiso
    const html3 = await fetch(`${t.base}/api/backup/google/callback?error=access_denied`).then((r) => r.text());
    assert.match(html3, /No diste el permiso/);
  } finally { t.close(); g.close(); }
});
