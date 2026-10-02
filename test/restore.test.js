import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from './helpers.js';
import { fakeGoogle } from './fakegoogle.js';
import { openDb } from '../db.js';
import { createBackups, normalizeTimes, latestSlot, nextSlot } from '../backup.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'liuvi-rs-'));
const D = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi);
const stateOf = (url) => new URL(url).searchParams.get('state');

test('horarios: se normalizan, y se calcula el último y el próximo', () => {
  assert.deepEqual(normalizeTimes(['20:00', '08:00', '8:00', '25:00', '08:00', 'x']), ['08:00', '20:00']);
  assert.deepEqual(normalizeTimes('["09:30"]'), ['09:30']);
  assert.deepEqual(normalizeTimes('basura'), []);
  const ts = ['08:00', '14:00', '20:00'];
  assert.equal(latestSlot(D(2026, 10, 2, 15, 0), ts), '2026-10-02 14:00');
  assert.equal(latestSlot(D(2026, 10, 2, 7, 59), ts), '2026-10-01 20:00', 'antes del primero: el último de ayer');
  assert.equal(latestSlot(D(2026, 10, 2, 8, 0), ts), '2026-10-02 08:00');
  assert.equal(nextSlot(D(2026, 10, 2, 15, 0), ts), '2026-10-02 20:00');
  assert.equal(nextSlot(D(2026, 10, 2, 21, 0), ts), '2026-10-03 08:00');
});

test('copias programadas: una por horario, con copia de repaso si estuvo apagado, y respetando las opciones', () => {
  const dir = tmp(), db = openDb(':memory:');
  try {
    const b = createBackups(db, { defaultDir: dir });
    assert.throws(() => b.configure({ times: [] }), /al menos un horario/);
    assert.throws(() => b.configure({ times: Array.from({ length: 25 }, (_, i) => `${String(i % 24).padStart(2, '0')}:${i < 24 ? '00' : '30'}`) }), /24 copias/);
    assert.throws(() => b.configure({ keep: 3 }), /entre 5 y 1000/);
    b.configure({ times: ['08:00', '20:00'], keep: 5, on_close: true });
    const s = b.status();
    assert.deepEqual(s.times, ['08:00', '20:00']); assert.equal(s.keep, 5); assert.equal(s.on_close, true); assert.ok(s.next_at);
    db.exec("DELETE FROM settings WHERE key='backup_last_slot'");
    const n = () => readdirSync(dir).filter((f) => f.startsWith('liuvi-backup-')).length;
    assert.ok(b.check(D(2026, 10, 2, 9, 0)), 'pasó el horario de las 8: hace la copia');
    assert.equal(b.check(D(2026, 10, 2, 9, 30)), null, 'ya se hizo');
    assert.ok(b.check(D(2026, 10, 2, 20, 5)));
    assert.equal(b.check(D(2026, 10, 3, 7, 0)), null, 'las 20:00 de ayer ya estaban hechas');
    assert.ok(b.check(D(2026, 10, 3, 8, 1)));
    assert.equal(n(), 3);
    assert.equal(b.status().last_reason, 'programada');
    // Estuvo apagado todo el día: al encender se hace una sola copia de repaso
    assert.ok(b.check(D(2026, 10, 6, 23, 0)));
    assert.equal(b.check(D(2026, 10, 6, 23, 1)), null);
    // Se conservan solo las últimas «keep»
    for (let i = 0; i < 6; i++) b.run('manual');
    assert.equal(n(), 5);
    // Copias automáticas apagadas: ni programadas ni al cerrar la caja
    b.configure({ auto: false });
    assert.equal(b.check(D(2026, 10, 9, 23, 0)), null);
    assert.equal(b.tryRun('cierre de caja'), null);
    b.configure({ auto: true, on_close: false });
    assert.equal(b.tryRun('cierre de caja'), null, 'sin «al cerrar la caja»');
    assert.ok(b.tryRun('manual'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function conDatos(t) {
  const mk = (o) => t.admin('POST', '/api/articles', { cost: 4000, stock: 10, ...o });
  const a = (await mk({ name: 'Vestido', brand: 'Koxis', price: 10000, barcode: 'V1' })).data;
  await mk({ name: 'Remera', brand: 'Adicta', price: 5000, barcode: 'R1' });
  await t.admin('POST', '/api/customers', { name: 'Ana Pérez' });
  await t.admin('POST', '/api/cash/open', { amount: 0 });
  await t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 10000 }] });
  return a;
}
const login = (t) => t.admin('POST', '/api/auth/login', { username: 'admin', password: 'clave-segura-1' });
const articulos = async (t) => (await t.admin('GET', '/api/articles?all=1')).data.map((x) => x.name).sort();

test('restaurar: vuelve todo a como estaba, deja una copia previa y conserva los ajustes de esta computadora', async () => {
  const t = await start();
  const dir = tmp();
  try {
    await t.admin('PUT', '/api/backup', { dir, pc_name: 'Caja 1' });
    const a = await conDatos(t);
    await t.admin('POST', '/api/backup/run', {});
    const nombre = (await t.admin('GET', '/api/backup')).data.files[0].name;
    // Después se pierde / se rompe algo
    await t.admin('DELETE', `/api/articles/${a.id}`);
    await t.admin('POST', '/api/articles', { name: 'Prenda nueva', price: 1, cost: 1, stock: 1 });
    await t.admin('POST', '/api/customers', { name: 'Cliente de después' });
    assert.deepEqual(await articulos(t), ['Prenda nueva', 'Remera', 'Vestido']); // «Vestido» sigue como baja

    const body = { source: 'local', name: nombre };
    assert.equal((await t.admin('POST', '/api/backup/restore', body)).status, 400, 'hace falta escribir RESTAURAR');
    assert.equal((await t.admin('POST', '/api/backup/restore', { ...body, confirm: 'restaurar' })).status, 200, 'sin distinguir mayúsculas');
    assert.equal((await t.admin('GET', '/api/articles')).status, 401, 'las sesiones se cierran');
    assert.equal((await login(t)).status, 200);
    assert.deepEqual(await articulos(t), ['Remera', 'Vestido'], 'vuelve el artículo borrado y desaparece lo posterior');
    assert.equal((await t.admin('GET', '/api/articles')).data.find((x) => x.name === 'Vestido').active, 1);
    assert.deepEqual((await t.admin('GET', '/api/customers')).data.map((c) => c.name), ['Ana Pérez']);
    assert.equal((await t.admin('GET', '/api/sales')).data.length, 1);
    const st = (await t.admin('GET', '/api/backup')).data;
    assert.equal(st.dir, dir, 'la carpeta de copias de esta computadora se conserva'); assert.equal(st.pc_name, 'Caja 1');
    const previa = readdirSync(dir).filter((f) => f.startsWith('liuvi-antes-de-restaurar-'));
    assert.equal(previa.length, 1);
    assert.ok(st.restore_files.some((f) => f.kind === 'previa') && st.restore_files.some((f) => f.kind === 'copia'));
    // La copia previa tiene lo de antes de restaurar: se puede «deshacer» restaurándola
    assert.equal((await t.admin('POST', '/api/backup/restore', { source: 'local', name: previa[0], confirm: 'RESTAURAR' })).status, 200);
    await login(t);
    assert.deepEqual(await articulos(t), ['Prenda nueva', 'Remera', 'Vestido']);
    // Nombres inventados no salen de la carpeta
    assert.equal((await t.admin('POST', '/api/backup/restore', { source: 'local', name: '../../etc/passwd', confirm: 'RESTAURAR' })).status, 400);
    assert.equal((await t.admin('POST', '/api/backup/restore', { source: 'local', name: 'liuvi-backup-2020-01-01_00-00-00.db', confirm: 'RESTAURAR' })).status, 400);
  } finally { t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restaurar desde un archivo: valida, cuida los datos si falla y acepta copias de versiones anteriores', async () => {
  const t = await start();
  const dir = tmp(), work = tmp();
  try {
    await t.admin('PUT', '/api/backup', { dir });
    await conDatos(t);
    const subir = (buf, extra = {}) => t.admin('POST', '/api/backup/restore', { source: 'upload', data: buf.toString('base64'), confirm: 'RESTAURAR', ...extra });
    const antes = await articulos(t);

    // Archivos que no sirven: no tocan nada
    assert.equal((await subir(Buffer.from('esto no es una base de datos'))).status, 400);
    assert.equal((await subir(Buffer.alloc(0))).status, 400);
    const otra = join(work, 'otra.db'); const o = new DatabaseSync(otra); o.exec('CREATE TABLE cosas (x)'); o.close();
    const r1 = await subir(readFileSync(otra)); assert.equal(r1.status, 400); assert.match(r1.data.error, /no es una copia de Liu Vi/);
    const vacia = join(work, 'vacia.db'); const v = openDb(vacia); v.exec('DELETE FROM users'); v.close();
    const r2 = await subir(readFileSync(vacia)); assert.equal(r2.status, 400); assert.match(r2.data.error, /sin usuarios|no tiene usuarios/);
    assert.deepEqual(await articulos(t), antes, 'nada cambió');

    // Copias de partida: una copia real (con el administrador) que se modifica para simular versiones anteriores
    await t.admin('POST', '/api/backup/run', {});
    const base = join(dir, (await t.admin('GET', '/api/backup')).data.files[0].name);
    // Una copia hecha con una versión anterior (sin tablas ni columnas nuevas) se restaura igual
    const vieja = join(work, 'vieja.db'); copyFileSync(base, vieja); const w = new DatabaseSync(vieja);
    w.exec("UPDATE articles SET name='Prenda de la copia vieja' WHERE barcode='V1'");
    w.exec('DROP TABLE held_sales; DROP TABLE layaway_payments; DROP TABLE layaway_items; DROP TABLE layaways; ALTER TABLE sales DROP COLUMN surcharge');
    w.close();
    const ok = await subir(readFileSync(vieja)); assert.equal(ok.status, 200, JSON.stringify(ok.data));
    await login(t);
    assert.deepEqual(await articulos(t), ['Prenda de la copia vieja', 'Remera']);
    assert.equal((await t.admin('GET', '/api/held')).data.length, 0);

    // Si algo falla a mitad de camino, vuelve todo atrás (los datos actuales quedan intactos)
    const hoy = await articulos(t);
    const rota = join(work, 'rota.db'); copyFileSync(base, rota); const r = new DatabaseSync(rota);
    r.exec('ALTER TABLE articles DROP COLUMN name'); // la copia no trae una columna obligatoria
    r.close();
    const bad = await subir(readFileSync(rota)); assert.equal(bad.status, 400); assert.match(bad.data.error, /No se restauró nada/);
    assert.equal((await t.admin('GET', '/api/articles')).status, 200, 'la sesión sigue: no se tocó nada');
    assert.deepEqual(await articulos(t), hoy);
  } finally { t.close(); rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test('restaurar desde Google Drive: lista las copias de todas las computadoras y restaura la elegida', async () => {
  const g = await fakeGoogle();
  const t = await start({ google: { base: g.base } });
  const dir = tmp();
  try {
    await t.admin('PUT', '/api/backup', { dir, pc_name: 'Caja 1' });
    assert.equal((await t.admin('GET', '/api/backup/drive-list')).status, 400, 'sin Drive conectado');
    await t.admin('PUT', '/api/backup/google/credentials', { client_id: 'abc-1.apps.googleusercontent.com', client_secret: 'sec' });
    const st = (await t.admin('POST', '/api/backup/google/start', {})).data.url;
    await fetch(`${t.base}/api/backup/google/callback?state=${stateOf(st)}&code=c`);
    await conDatos(t);
    assert.equal((await t.admin('POST', '/api/backup/run', {})).status, 200);
    const lista = (await t.admin('GET', '/api/backup/drive-list')).data;
    assert.equal(lista.length, 1); assert.equal(lista[0].pc, 'Caja 1'); assert.match(lista[0].name, /^liuvi-backup-/); assert.ok(lista[0].size > 1000);
    await t.admin('POST', '/api/articles', { name: 'Prenda de después', price: 1, cost: 1, stock: 1 });
    assert.equal((await t.admin('POST', '/api/backup/restore', { source: 'drive', id: 'no-existe', confirm: 'RESTAURAR' })).status, 400);
    const ok = await t.admin('POST', '/api/backup/restore', { source: 'drive', id: lista[0].id, confirm: 'RESTAURAR' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    await login(t);
    assert.deepEqual(await articulos(t), ['Remera', 'Vestido']);
    assert.equal((await t.admin('GET', '/api/backup')).data.google.connected, true, 'la conexión con Google se conserva');
  } finally { t.close(); g.close(); rmSync(dir, { recursive: true, force: true }); }
});
