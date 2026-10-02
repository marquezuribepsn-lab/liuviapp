import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { start } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'liuvi-test-'));
const backups = (dir) => readdirSync(dir).filter((f) => /^liuvi-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/.test(f)).sort();

test('configurar carpeta: valida la ruta y exige el permiso', async () => {
  const t = await start();
  const dir = tmp();
  try {
    assert.equal((await t.admin('PUT', '/api/backup', { dir: 'relativa/carpeta' })).status, 400);
    assert.equal((await t.admin('PUT', '/api/backup', { dir: join(dir, 'no-existe') })).status, 400);
    const archivo = join(dir, 'archivo.txt'); writeFileSync(archivo, 'x');
    assert.equal((await t.admin('PUT', '/api/backup', { dir: archivo })).status, 400, 'un archivo no es una carpeta');
    assert.equal((await t.admin('POST', '/api/backup/run', {})).status, 400, 'sin carpeta no hay copia');
    const ok = await t.admin('PUT', '/api/backup', { dir, auto: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.dir, dir);

    // El vendedor no ve ni configura copias
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    for (const [m, p] of [['GET', '/api/backup'], ['PUT', '/api/backup'], ['POST', '/api/backup/run']]) assert.equal((await ana.call(m, p, m === 'GET' ? undefined : {})).status, 403);
  } finally { t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('la copia es una base válida con los datos y se hace sola al cerrar caja', async () => {
  const t = await start();
  const dir = tmp();
  try {
    await t.admin('PUT', '/api/backup', { dir });
    await t.admin('POST', '/api/articles', { barcode: '123', name: 'Remera', price: 1000, stock: 3 });
    const run = await t.admin('POST', '/api/backup/run', {});
    assert.equal(run.status, 200);
    const [file] = backups(dir);
    assert.ok(file, 'se creó el archivo');
    assert.equal(run.data.files[0].name, file);

    const copy = new DatabaseSync(join(dir, file), { readOnly: true });
    assert.equal(copy.prepare('SELECT name FROM articles').get().name, 'Remera');
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    copy.close();

    // Cierre de caja => copia automática (segundo archivo, con otro nombre)
    await new Promise((r) => setTimeout(r, 1100)); // el nombre lleva segundos
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    await t.admin('POST', '/api/cash/close', { counted: 0 });
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('liuvi-backup-')).length, 2);
    assert.equal((await t.admin('GET', '/api/backup')).data.last_reason, 'cierre de caja');

    // Con las copias automáticas apagadas, el cierre no copia
    await t.admin('PUT', '/api/backup', { dir, auto: false });
    await new Promise((r) => setTimeout(r, 1100));
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    await t.admin('POST', '/api/cash/close', { counted: 0 });
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('liuvi-backup-')).length, 2);
  } finally { t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('conserva solo las últimas 30 copias y no toca otros archivos', async () => {
  const t = await start();
  const dir = tmp();
  try {
    await t.admin('PUT', '/api/backup', { dir });
    for (let i = 1; i <= 35; i++) writeFileSync(join(dir, `liuvi-backup-2020-01-${String(i).padStart(2, '0')}_00-00-00.db`), 'viejo');
    writeFileSync(join(dir, 'foto-vacaciones.jpg'), 'no tocar');
    writeFileSync(join(dir, 'liuvi-backup-nada.db'), 'no coincide con el patrón');
    await t.admin('POST', '/api/backup/run', {});
    assert.equal(backups(dir).length, 30);
    assert.ok(existsSync(join(dir, 'foto-vacaciones.jpg')));
    assert.ok(existsSync(join(dir, 'liuvi-backup-nada.db')));
    assert.ok(backups(dir).some((f) => !f.startsWith('liuvi-backup-2020')), 'la nueva se conserva');
  } finally { t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restaurar: reemplaza la base, guarda la anterior y rechaza archivos inválidos', async () => {
  const t = await start();
  const dir = tmp(), work = tmp();
  try {
    await t.admin('PUT', '/api/backup', { dir });
    await t.admin('POST', '/api/articles', { barcode: '1', name: 'Original', price: 10, stock: 1 });
    await t.admin('POST', '/api/backup/run', {});
    const [file] = backups(dir);
    t.close();

    // "Base actual" distinta y dañada por el uso: se reemplaza por la copia
    const target = join(work, 'data', 'liuvi.db');
    const current = new DatabaseSync(join(work, 'x.db'));
    current.exec('CREATE TABLE otra (a)'); current.close();
    const run = (arg) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/restore.js', arg], { env: { ...process.env, DB_PATH: target }, encoding: 'utf8' });

    assert.notEqual(run(join(work, 'x.db')).status, 0, 'una base ajena no se acepta');
    assert.notEqual(run(join(work, 'no-existe.db')).status, 0);
    writeFileSync(join(work, 'basura.db'), 'esto no es sqlite');
    assert.notEqual(run(join(work, 'basura.db')).status, 0);

    const ok = run(join(dir, file));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(new DatabaseSync(target).prepare('SELECT name FROM articles').get().name, 'Original');

    // Segunda restauración: la base que había se guarda aparte
    const again = run(join(dir, file));
    assert.equal(again.status, 0);
    assert.ok(readdirSync(join(work, 'data')).some((f) => f.includes('antes-de-restaurar')));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});

test('copia programada: se dispara en el horario y el aviso «Respaldando» queda visible', async () => {
  const t = await start();
  const dir = tmp();
  try {
    await t.admin('PUT', '/api/backup', { dir, times: ['08:00', '20:00'] });
    const b = t.app.backups;
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
    assert.ok(b.check(at(12, 0)), 'pasadas las 08:00 se hace la copia sola');
    assert.equal(b.check(at(12, 5)), null, 'no repite en el mismo horario');
    assert.ok(b.check(at(23, 0)), 'pasadas las 20:00 se hace otra copia');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('liuvi-backup-')).length, 2);
    assert.equal(b.check(at(23, 30)), null, 'no repite en el mismo horario');
    const act = (await t.client().call('GET', '/api/backup/activity')).data;
    assert.equal(act.show, true);
    assert.equal(act.ok, true);
    assert.equal(act.error, undefined);
  } finally { t.close(); rmSync(dir, { recursive: true, force: true }); }
});
