import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { openDb, dataDirFor, migrateLegacyDb } from '../db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p = 'liuvi-dd-') => mkdtempSync(join(tmpdir(), p));

test('la carpeta de datos es fija, por usuario y fuera del programa', () => {
  assert.equal(dataDirFor('win32', { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' }, 'C:\\Users\\Ana'), join('C:\\Users\\Ana\\AppData\\Local', 'LiuVi'));
  assert.equal(dataDirFor('win32', {}, join('C:', 'Users', 'Ana')), join('C:', 'Users', 'Ana', 'AppData', 'Local', 'LiuVi'));
  assert.equal(dataDirFor('darwin', {}, '/Users/ana'), join('/Users/ana', 'Library', 'Application Support', 'LiuVi'));
  assert.equal(dataDirFor('linux', {}, '/home/ana'), join('/home/ana', '.local', 'share', 'liuvi'));
  assert.equal(dataDirFor('linux', { XDG_DATA_HOME: '/datos' }, '/home/ana'), join('/datos', 'liuvi'));
  assert.equal(dataDirFor('win32', { LIUVI_DATA_DIR: 'D:\\MisDatos' }, 'C:\\Users\\Ana'), 'D:\\MisDatos', 'se puede elegir otra carpeta');
  const real = dataDirFor();
  assert.ok(!(real + sep).startsWith(ROOT + sep), 'no debe quedar dentro de la carpeta del programa');
});

test('migración: trae la base vieja (<programa>/data) sin tocarla y sin pisar una existente', () => {
  const dir = tmp(), legacy = join(dir, 'viejo', 'liuvi.db'), target = join(dir, 'nuevo', 'liuvi.db');
  mkdirSync(dirname(legacy), { recursive: true });
  const old = openDb(legacy);
  old.prepare("INSERT INTO users (username,name,password_hash,role_id) VALUES ('marina','Marina','x',1)").run();
  old.prepare("INSERT INTO articles (name,price,stock) VALUES ('Remera',100,7)").run();
  old.close();

  assert.deepEqual(migrateLegacyDb(join(dir, 'no-existe.db'), target), { migrated: false }, 'sin base vieja no hace nada');
  assert.equal(existsSync(target), false);

  const r = migrateLegacyDb(legacy, target);
  assert.equal(r.migrated, true);
  const nuevo = openDb(target);
  assert.equal(nuevo.prepare('SELECT name FROM users').get().name, 'Marina', 'el usuario sigue');
  assert.equal(nuevo.prepare('SELECT stock FROM articles').get().stock, 7, 'el stock sigue');
  nuevo.prepare("INSERT INTO articles (name,price,stock) VALUES ('Otra',1,1)").run();
  nuevo.close();
  assert.ok(existsSync(legacy), 'la original queda como respaldo');

  assert.equal(migrateLegacyDb(legacy, target).migrated, false, 'no vuelve a copiar encima de la base ya en uso');
  const chk = openDb(target); assert.equal(chk.prepare('SELECT COUNT(*) n FROM articles').get().n, 2); chk.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- Extremo a extremo: el problema real (programa en otra carpeta => "se borró el usuario") ----
const freePort = () => new Promise((res) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
function copyProgram(dest) {
  mkdirSync(dest, { recursive: true });
  for (const f of ['app.js', 'auth.js', 'backup.js', 'db.js', 'server.js', 'package.json']) cpSync(join(ROOT, f), join(dest, f));
  cpSync(join(ROOT, 'public'), join(dest, 'public'), { recursive: true });
}
async function runServer(programDir, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: programDir, env: { ...process.env, PORT: String(port), DB_PATH: '', ...env } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('listo'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(out.includes('listo'), 'el servidor no arrancó: ' + out);
  const base = `http://127.0.0.1:${port}`;
  const me = async () => (await (await fetch(base + '/api/auth/me')).json()).setupNeeded;
  return { out: () => out, me, base, kill: (sig = 'SIGKILL') => new Promise((r) => { child.once('exit', r); child.kill(sig); }) };
}

test('E2E: el usuario sobrevive a un corte brusco y a abrir el programa desde OTRA carpeta', async () => {
  const work = tmp('liuvi-e2e-'), datos = join(work, 'datos');
  const p1 = join(work, 'ZIP-viejo'), p2 = join(work, 'ZIP-nuevo');
  copyProgram(p1); copyProgram(p2);
  const env = { LIUVI_DATA_DIR: datos };
  try {
    const a = await runServer(p1, env);
    assert.equal(await a.me(), true, 'primera vez: pide crear el administrador');
    assert.match(a.out(), /Datos guardados: ninguno todavía/);
    const setup = await fetch(a.base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'marina', name: 'Marina', password: 'clave-segura-1' }) });
    assert.equal(setup.status, 201);
    await a.kill('SIGKILL'); // como cerrar la ventana negra de golpe

    const b = await runServer(p1, env);
    assert.equal(await b.me(), false, 'misma carpeta, tras corte brusco: el usuario sigue');
    assert.match(b.out(), /Datos guardados: 1 usuario\(s\)/, 'la ventana muestra que encontró los datos');
    assert.match(b.out(), /Liu Vi v\d+\.\d+\.\d+/);
    await b.kill();

    const c = await runServer(p2, env); // ZIP nuevo extraído en otra carpeta
    assert.equal(await c.me(), false, 'otra carpeta del programa: el usuario sigue');
    const login = await fetch(c.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'marina', password: 'clave-segura-1' }) });
    assert.equal(login.status, 200);
    assert.ok(!existsSync(join(p1, 'data')) && !existsSync(join(p2, 'data')), 'no se crea nada dentro de la carpeta del programa');
    await c.kill();
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('E2E: quien ya tenía datos en <programa>/data los conserva al actualizar', async () => {
  const work = tmp('liuvi-e2e-'), datos = join(work, 'datos'), prog = join(work, 'programa');
  copyProgram(prog);
  mkdirSync(join(prog, 'data'));
  const old = openDb(join(prog, 'data', 'liuvi.db'));
  old.prepare("INSERT INTO users (username,name,password_hash,role_id) VALUES ('marina','Marina','x',1)").run();
  old.close();
  try {
    const s = await runServer(prog, { LIUVI_DATA_DIR: datos });
    assert.equal(await s.me(), false, 'el usuario de la versión anterior aparece');
    assert.match(s.out(), /trasladó tu base de datos anterior/);
    assert.ok(existsSync(join(datos, 'liuvi.db')));
    await s.kill();
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('Copias muestra dónde está la base', async () => {
  const { start } = await import('./helpers.js');
  const t = await start();
  try {
    const st = (await t.admin('GET', '/api/backup')).data;
    assert.ok('db_file' in st);
  } finally { t.close(); }
});

test('detecta un programa en carpeta temporal o dentro de un ZIP', async () => {
  const { looksTemporary } = await import('../db.js');
  const tmpWin = 'C:\\Users\\Ana\\AppData\\Local\\Temp';
  assert.equal(looksTemporary('C:\\Users\\Ana\\AppData\\Local\\Temp\\Temp1_liuviapp-main.zip\\liuviapp-main', tmpWin), true);
  assert.equal(looksTemporary('C:\\Users\\Ana\\AppData\\Local\\Temp\\algo\\liuviapp', tmpWin), true);
  assert.equal(looksTemporary('C:\\Users\\Ana\\Downloads\\liuviapp-main.zip\\liuviapp-main', 'C:\\x'), true);
  assert.equal(looksTemporary('/tmp/xyz/liuviapp', '/tmp'), true);
  assert.equal(looksTemporary('C:\\Users\\Ana\\Documents\\liuviapp-main', tmpWin), false);
  assert.equal(looksTemporary('/home/ana/liuviapp', '/tmp'), false);
});

test('/api/auth/me informa la versión y, sin usuarios, dónde busca la base', async () => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../app.js');
  const { appVersion } = await import('../db.js');
  const dir = tmp(), file = join(dir, 'liuvi.db');
  const server = createServer(createApp(openDb(file)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const vacio = await (await fetch(base + '/api/auth/me')).json();
    assert.equal(vacio.version, appVersion());
    assert.match(vacio.version, /^\d+\.\d+\.\d+$/);
    assert.equal(vacio.setupNeeded, true);
    assert.equal(vacio.dbFile, file, 'sin usuarios dice dónde busca');
    await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'marina', password: 'clave-segura-1' }) });
    const conUsuario = await (await fetch(base + '/api/auth/me')).json();
    assert.equal(conUsuario.setupNeeded, false);
    assert.equal(conUsuario.dbFile, undefined, 'con usuarios no se expone la ruta');
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
