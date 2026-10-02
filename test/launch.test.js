import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCommand, openBrowser, probeInstance, portBusyMessage, appWindowCommand } from '../launch.js';
import { appVersion } from '../db.js';
import { start, copyProgram, runServer, launch, freePort } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'liuvi-ln-'));

test('abre el navegador con el comando de cada sistema, sin romper si falla', () => {
  assert.deepEqual(browserCommand('win32', 'http://localhost:3000'), ['rundll32', ['url.dll,FileProtocolHandler', 'http://localhost:3000']]);
  assert.deepEqual(browserCommand('darwin', 'http://localhost:3000'), ['open', ['http://localhost:3000']]);
  assert.deepEqual(browserCommand('linux', 'http://localhost:3000'), ['xdg-open', ['http://localhost:3000']]);
  const calls = [];
  openBrowser('http://x', { platform: 'win32', spawnFn: (...a) => { calls.push(a); return { on() {}, unref() {} }; } });
  assert.equal(calls[0][0], 'rundll32'); assert.equal(calls[0][2].detached, true);
  assert.doesNotThrow(() => openBrowser('http://x', { spawnFn: () => { throw new Error('no hay navegador'); } }));
});

test('detecta qué hay en un puerto ocupado: otra copia de Liu Vi (con su versión) u otro programa', async () => {
  const t = await start();
  const port = Number(new URL(t.base).port);
  const otro = createServer((req, res) => res.end('hola')); await new Promise((r) => otro.listen(0, '127.0.0.1', r));
  try {
    assert.deepEqual(await probeInstance(port), { version: appVersion() });
    assert.equal(await probeInstance(otro.address().port), null, 'otro programa en el puerto');
    assert.equal(await probeInstance(await freePort()), null, 'nada en el puerto');
  } finally { t.close(); otro.close(); }
  assert.match(portBusyMessage(3000, '1.4.0', { version: '1.3.0' }), /OTRA COPIA.*\n.*1\.3\.0.*\n.*1\.4\.0[\s\S]*cerra la ventana negra anterior/);
  assert.match(portBusyMessage(3000, '1.4.0', { version: '1.4.0' }), /ya esta abierto \(version 1\.4\.0\)/);
  assert.match(portBusyMessage(3000, '1.4.0', null), /ocupado por otro programa/);
});

test('E2E: abrir una versión nueva con la vieja todavía abierta lo dice claro y no abre el navegador', async () => {
  const fs = await import('node:fs');
  const work = tmp(), datos = join(work, 'datos'), bin = join(work, 'bin'), abierto = join(work, 'abierto.txt');
  const vieja = join(work, 'vieja'), nueva = join(work, 'nueva');
  copyProgram(vieja, { version: '1.3.0' }); copyProgram(nueva);
  // «xdg-open» de mentira que anota la dirección que se le pide abrir
  fs.mkdirSync(bin); writeFileSync(join(bin, 'xdg-open'), `#!/bin/sh\necho "$1" >> "${abierto}"\n`); chmodSync(join(bin, 'xdg-open'), 0o755);
  const env = { LIUVI_DATA_DIR: datos, PATH: `${bin}:${process.env.PATH}`, LIUVI_OPEN: '1' };
  const abrio = () => fs.promises.access(abierto).then(() => true, () => false);
  try {
    const a = await runServer(vieja, env); // la versión vieja sigue abierta
    assert.match(fs.readFileSync(abierto, 'utf8'), new RegExp(`:${a.port}`), 'al arrancar bien, abre el navegador');
    fs.rmSync(abierto);

    const b = launch(nueva, env, a.port); // se abre la nueva en el mismo puerto
    assert.equal(await b.exited, 1);
    assert.match(b.out(), /OTRA COPIA de Liu Vi/);
    assert.match(b.out(), /esta abierta es la version 1\.3\.0/);
    assert.match(b.out(), new RegExp(`la version ${appVersion().replaceAll('.', '\\.')}`));
    assert.match(b.out(), /cerra la ventana negra anterior/);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!(await abrio()), 'con el puerto ocupado NO se abre el navegador (mostraría la versión vieja)');

    // Cerrada la vieja, la nueva arranca y abre el navegador
    await a.kill();
    const c = await runServer(nueva, env);
    for (let i = 0; i < 60 && !(await abrio()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(fs.readFileSync(abierto, 'utf8'), new RegExp(`:${c.port}`));

    // Abrir dos veces la misma versión: avisa que ya está abierta
    const d = launch(nueva, env, c.port);
    assert.equal(await d.exited, 1);
    assert.match(d.out(), new RegExp(`ya esta abierto \\(version ${appVersion().replaceAll('.', '\\.')}\\)`));
    await c.kill();
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('el navegador no reutiliza código viejo: sin caché para la página y los scripts, y los scripts llevan la versión', async () => {
  const t = await start();
  try {
    const v = appVersion();
    const home = await fetch(t.base + '/');
    const html = await home.text();
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.match(html, new RegExp(`<script src="/app\\.js\\?v=${v.replaceAll('.', '\\.')}"></script>`));
    assert.match(html, new RegExp(`href="/style\\.css\\?v=${v.replaceAll('.', '\\.')}"`));
    assert.match(html, new RegExp(`<meta name="liuvi-version" content="${v.replaceAll('.', '\\.')}">`));
    assert.ok(!html.includes('__VERSION__'));

    for (const f of ['/app.js?v=' + v, '/style.css', '/barcode.js']) {
      const r = await fetch(t.base + f);
      assert.equal(r.status, 200, f); assert.equal(r.headers.get('cache-control'), 'no-cache', f);
      const etag = r.headers.get('etag'); assert.ok(etag, f);
      const again = await fetch(t.base + f, { headers: { 'If-None-Match': etag } });
      assert.equal(again.status, 304, 'sin cambios: el navegador reutiliza lo que tiene (' + f + ')');
      assert.equal((await fetch(t.base + f, { headers: { 'If-None-Match': '"otro"' } })).status, 200);
    }
    const img = await fetch(t.base + '/img/logo-blanco.png');
    assert.equal(img.headers.get('content-type'), 'image/png'); assert.match(img.headers.get('cache-control'), /max-age=86400/);
    assert.equal((await fetch(t.base + '/no-existe.js')).status, 404);
    assert.equal((await fetch(t.base + '/img')).status, 404, 'una carpeta no es un archivo');
  } finally { t.close(); }
});

test('modo ventana de aplicación: Edge o Chrome en Windows, y navegador común si no hay', () => {
  const env = { 'ProgramFiles(x86)': 'C:/PF86', ProgramFiles: 'C:/PF' };
  const [exe, args] = appWindowCommand('http://localhost:3000', { platform: 'win32', env, exists: (p) => p.includes('PF86') && p.includes('msedge') });
  assert.ok(exe.endsWith('msedge.exe'));
  assert.ok(args.includes('--app=http://localhost:3000'));
  assert.ok(appWindowCommand('http://x', { platform: 'win32', env, exists: (p) => p.includes('chrome') })[0].endsWith('chrome.exe'), 'sin Edge usa Chrome');
  assert.equal(appWindowCommand('http://x', { platform: 'win32', env, exists: () => false }), null);
  assert.equal(appWindowCommand('http://x', { platform: 'darwin', env, exists: () => true }), null);
  const calls = [];
  const spawnFn = (...a) => { calls.push(a); return { on() {}, unref() {} }; };
  openBrowser('http://x', { platform: 'win32', spawnFn, appWindow: true, env, exists: () => false });
  assert.equal(calls[0][0], 'rundll32', 'sin Edge ni Chrome abre el navegador predeterminado');
  openBrowser('http://x', { platform: 'win32', spawnFn, appWindow: true, env, exists: (p) => p.includes('msedge') });
  assert.ok(calls[1][0].endsWith('msedge.exe'));
  openBrowser('http://x', { platform: 'win32', spawnFn, exists: () => true });
  assert.equal(calls[2][0], 'rundll32', 'sin pedir ventana propia no se usa');
});
