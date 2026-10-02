import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { createUpdater, isNewer } from '../updater.js';
import { writeZip } from '../xlsx.js';
import { start } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(js|json|html|css|md|vbs|svg)$/;

// «Versión nueva» armada con los archivos reales del programa (solo los de texto), igual que el ZIP de GitHub.
function newVersionZip(version, tweak = (f) => f) {
  const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && TEXT.test(f));
  const files = list.map((name) => {
    let data = readFileSync(join(ROOT, name), 'utf8');
    if (name === 'package.json') data = JSON.stringify({ ...JSON.parse(data), version });
    return tweak({ name: `liuviapp-main/${name}`, data });
  });
  return writeZip(files);
}
const fakeFetch = (version, zip) => async (url) => {
  if (url.endsWith('package.json')) return { ok: true, text: async () => JSON.stringify({ version }) };
  return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) };
};
function installedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'liuvi-upd-'));
  mkdirSync(join(dir, 'public'), { recursive: true }); mkdirSync(join(dir, 'runtime'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(dir, 'app.js'), '// version vieja');
  writeFileSync(join(dir, 'viejo.js'), '// modulo que ya no existe');
  writeFileSync(join(dir, 'public', 'index.html'), 'vieja');
  writeFileSync(join(dir, 'google-client.json'), '{"secreto":1}');
  writeFileSync(join(dir, 'runtime', 'node.exe'), 'motor');
  return dir;
}

test('comparación de versiones', () => {
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(isNewer('2.0.0', '1.99.99'));
  assert.ok(!isNewer('1.2.3', '1.2.3'));
  assert.ok(!isNewer('1.2.2', '1.2.3'));
  assert.ok(!isNewer('abc', '1.2.3'));
});

test('actualizar: descarga, prueba, reemplaza el código y conserva datos, runtime y Google', async () => {
  const dir = installedDir(), db = openDb(':memory:');
  try {
    let backedUp = 0;
    const up = createUpdater(db, { appDir: dir, version: '1.0.0', enabled: true, fetchFn: fakeFetch('99.0.0', newVersionZip('99.0.0')), beforeApply: () => { backedUp++; } });
    assert.equal((await up.check()).available, true);
    const r = await up.apply();
    assert.deepEqual([r.from, r.to], ['1.0.0', '99.0.0']);
    assert.equal(backedUp, 1, 'hace la copia de seguridad antes de reemplazar');
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '99.0.0');
    assert.equal(readFileSync(join(dir, 'app.js'), 'utf8'), readFileSync(join(ROOT, 'app.js'), 'utf8'));
    assert.ok(existsSync(join(dir, 'public', 'app.js')));
    assert.equal(readFileSync(join(dir, 'google-client.json'), 'utf8'), '{"secreto":1}', 'la conexión con Google no se toca');
    assert.equal(readFileSync(join(dir, 'runtime', 'node.exe'), 'utf8'), 'motor');
    assert.equal(readFileSync(join(dir, '.update', 'anterior', 'app.js'), 'utf8'), '// version vieja', 'queda la versión anterior');
    assert.ok(existsSync(join(dir, '.update', 'anterior', 'viejo.js')), 'los módulos que ya no existen se retiran (y quedan en la copia anterior)');
    assert.ok(!existsSync(join(dir, 'viejo.js')));
    assert.ok(!existsSync(join(dir, 'test')), 'no instala las pruebas');
    assert.equal(up.status().previous, true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('actualizar: una versión con errores se rechaza y no se toca nada', async () => {
  const dir = installedDir(), db = openDb(':memory:');
  try {
    const roto = newVersionZip('99.0.0', (f) => (f.name.endsWith('/backup.js') ? { ...f, data: 'export const x = {;' } : f));
    const up = createUpdater(db, { appDir: dir, version: '1.0.0', enabled: true, fetchFn: fakeFetch('99.0.0', roto) });
    await assert.rejects(() => up.apply(), /error en backup\.js/);
    assert.equal(readFileSync(join(dir, 'app.js'), 'utf8'), '// version vieja');
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.0.0');
    assert.ok(!existsSync(join(dir, '.update', 'nueva')), 'limpia la carpeta de prueba');

    // Versión declarada distinta de la descargada
    const mal = createUpdater(db, { appDir: dir, version: '1.0.0', enabled: true, fetchFn: fakeFetch('98.0.0', newVersionZip('99.0.0')) });
    await assert.rejects(() => mal.apply(), /no es la esperada/);
    // Sin versión más nueva
    const igual = createUpdater(db, { appDir: dir, version: '99.0.0', enabled: true, fetchFn: fakeFetch('99.0.0', newVersionZip('99.0.0')) });
    await assert.rejects(() => igual.apply(), /última versión/);
    // Si la copia de seguridad falla, no se actualiza
    const sinCopia = createUpdater(db, { appDir: dir, version: '1.0.0', enabled: true, fetchFn: fakeFetch('99.0.0', newVersionZip('99.0.0')), beforeApply: () => { throw new Error('no hay carpeta'); } });
    await assert.rejects(() => sinCopia.apply(), /no hay carpeta/);
    assert.equal(readFileSync(join(dir, 'app.js'), 'utf8'), '// version vieja');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('actualizar: sin internet se avisa claro y en la API solo lo usa el administrador', async () => {
  const dir = installedDir(), db = openDb(':memory:');
  try {
    const off = createUpdater(db, { appDir: dir, version: '1.0.0', enabled: true, fetchFn: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(() => off.check(), /hay internet/);
    assert.match(off.status().error, /internet/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }

  let restarted = 0;
  const dir2 = installedDir();
  const t = await start({ restart: () => { restarted++; }, update: { appDir: dir2, enabled: true, fetchFn: fakeFetch('99.0.0', newVersionZip('99.0.0')), beforeApply: () => {} } });
  try {
    assert.equal((await t.admin('POST', '/api/update/check', {})).data.available, true);
    assert.equal((await t.admin('GET', '/api/dashboard')).data.update.latest, '99.0.0');
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('POST', '/api/update/apply', {})).status, 403);
    const r = await t.admin('POST', '/api/update/apply', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.restarting, true);
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(restarted, 1, 'pide reiniciar después de responder');
    assert.equal((await t.admin('PUT', '/api/update', { auto: false })).data.auto, false);
  } finally { t.close(); rmSync(dir2, { recursive: true, force: true }); }
});
