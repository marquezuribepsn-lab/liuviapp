import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { start } from './helpers.js';
import { openDb, clearSessionsIfRequired } from '../db.js';
import { createApp } from '../app.js';
import { createLimiter, isWeakPin, isLoopback, PIN_RE } from '../auth.js';

const PW = 'clave-segura-1';
const login = (c, username, password) => c.call('POST', '/api/auth/login', { username, password });
async function addUser(t, username, password, roleName = 'Vendedor') {
  const roles = (await t.admin('GET', '/api/roles')).data;
  const r = await t.admin('POST', '/api/users', { username, name: username, password, role_id: roles.find((x) => x.name === roleName).id });
  assert.equal(r.status, 201);
  return r.data.id;
}

test('PIN: se pone con la contraseña actual, rechaza los débiles y sirve para iniciar sesión', async () => {
  const t = await start();
  try {
    assert.equal((await t.admin('GET', '/api/auth/me')).data.user.hasPin, false);
    assert.equal((await t.admin('POST', '/api/auth/pin', { current: 'incorrecta', pin: '4821' })).status, 403);
    for (const pin of ['123', '123456789', 'abcd', '48a1', '0000', '1234', '4321', '55555', '']) {
      assert.equal((await t.admin('POST', '/api/auth/pin', { current: PW, pin })).status, 400, `PIN rechazado: "${pin}"`);
    }
    assert.equal((await t.admin('POST', '/api/auth/pin', { current: PW, pin: '4821' })).status, 200);
    assert.equal((await t.admin('GET', '/api/auth/me')).data.user.hasPin, true);
    assert.match(t.db.prepare("SELECT pin_hash FROM users WHERE username='admin'").get().pin_hash, /^scrypt\$/, 'el PIN se guarda cifrado');

    assert.equal((await login(t.client(), 'admin', '4821')).status, 200, 'entra con el PIN');
    assert.equal((await login(t.client(), 'ADMIN', PW)).status, 200, 'la contraseña sigue funcionando');
    assert.equal((await login(t.client(), 'admin', '4822')).status, 401, 'PIN equivocado');

    // Una contraseña numérica de quien no tiene PIN sigue siendo una contraseña válida
    await addUser(t, 'leo', '87654321');
    assert.equal((await login(t.client(), 'leo', '87654321')).status, 200);
    assert.equal((await login(t.client(), 'leo', '4821')).status, 401, 'el PIN de otro usuario no sirve');

    // Quitar el PIN
    assert.equal((await t.admin('POST', '/api/auth/pin/remove', { current: 'mala' })).status, 403);
    assert.equal((await t.admin('POST', '/api/auth/pin/remove', { current: PW })).status, 200);
    assert.equal((await login(t.client(), 'admin', '4821')).status, 401);
  } finally { t.close(); }
});

// Llama al manejador con un pedido simulado para poder fijar la dirección de origen.
function fakeCall(handle, { method = 'POST', url, body, remote = '127.0.0.1', cookie }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, socket: { remoteAddress: remote } });
  return new Promise((resolve) => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, writeHead: (s, h) => { res.status = s; Object.assign(headers, h || {}); }, end: (b) => resolve({ status: res.status, data: b ? JSON.parse(b) : null, headers }) };
    handle(req, res);
  });
}

test('el PIN solo vale desde la propia computadora; la contraseña vale desde la red', async () => {
  const handle = createApp(openDb(':memory:'));
  const setup = await fakeCall(handle, { url: '/api/auth/setup', body: { username: 'marina', name: 'Marina', password: PW } });
  assert.equal(setup.status, 201);
  const cookie = setup.headers['set-cookie'].split(';')[0];
  assert.equal((await fakeCall(handle, { url: '/api/auth/pin', body: { current: PW, pin: '4821' }, cookie })).status, 200);

  const viaPin = (remote) => fakeCall(handle, { url: '/api/auth/login', body: { username: 'marina', password: '4821' }, remote });
  assert.equal((await viaPin('127.0.0.1')).status, 200);
  assert.equal((await viaPin('::1')).status, 200);
  assert.equal((await viaPin('192.168.1.50')).status, 401, 'desde otro aparato de la red el PIN no entra');
  assert.equal((await fakeCall(handle, { url: '/api/auth/login', body: { username: 'marina', password: PW }, remote: '192.168.1.50' })).status, 200, 'la contraseña sí');
});

test('bloqueo: la sesión sigue abierta pero hace falta PIN o contraseña para continuar', async () => {
  const t = await start();
  try {
    await t.admin('POST', '/api/auth/pin', { current: PW, pin: '4821' });
    const c = t.client(); await login(c, 'admin', PW);
    assert.equal((await c.call('GET', '/api/articles')).status, 200);

    assert.equal((await c.call('POST', '/api/auth/lock', {})).status, 200);
    const blocked = await c.call('GET', '/api/articles');
    assert.equal(blocked.status, 401);
    assert.equal(blocked.data.locked, true);
    assert.equal((await c.call('PUT', '/api/security', { idleLockMinutes: 0 })).status, 401, 'bloqueada no puede cambiar nada');
    const me = (await c.call('GET', '/api/auth/me')).data;
    assert.equal(me.locked, true);
    assert.equal(me.user, null, 'no se entregan permisos ni datos del usuario');
    assert.equal(me.lockedName, 'Admin');

    assert.equal((await c.call('POST', '/api/auth/unlock', { secret: 'mal' })).status, 401);
    assert.equal((await c.call('POST', '/api/auth/unlock', { secret: '4821' })).status, 200, 'desbloquea con el PIN');
    assert.equal((await c.call('GET', '/api/articles')).status, 200);

    await c.call('POST', '/api/auth/lock', {});
    assert.equal((await c.call('POST', '/api/auth/unlock', { secret: PW })).status, 200, 'o con la contraseña');

    // Se puede salir estando bloqueado; un intruso no entra con la sesión de otro
    await c.call('POST', '/api/auth/lock', {});
    assert.equal((await c.call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await c.call('GET', '/api/articles')).status, 401);
  } finally { t.close(); }
});

test('desbloquear tiene límite de intentos', async () => {
  const t = await start();
  try {
    const c = t.client(); await login(c, 'admin', PW);
    await c.call('POST', '/api/auth/lock', {});
    for (let i = 0; i < 5; i++) assert.equal((await c.call('POST', '/api/auth/unlock', { secret: 'mal' + i })).status, 401);
    const r = await c.call('POST', '/api/auth/unlock', { secret: PW });
    assert.equal(r.status, 429, 'tras 5 errores se bloquea aunque venga la clave correcta');
    assert.equal(r.data.locked, true);
  } finally { t.close(); }
});

test('bloqueo por inactividad configurable por el administrador', async () => {
  const t = await start();
  try {
    const ago = (min) => new Date(Date.now() - min * 60_000).toLocaleString('sv-SE');
    const set = (min) => t.admin('PUT', '/api/security', { idleLockMinutes: min });

    // Sin configurar, la inactividad no bloquea
    t.db.prepare('UPDATE user_sessions SET last_seen = ?').run(ago(600));
    assert.equal((await t.admin('GET', '/api/articles')).status, 200);

    assert.equal((await set(5)).data.idleLockMinutes, 5);
    t.db.prepare('UPDATE user_sessions SET last_seen = ?').run(ago(4));
    assert.equal((await t.admin('GET', '/api/articles')).status, 200, '4 min de 5: sigue abierta');
    t.db.prepare('UPDATE user_sessions SET last_seen = ?').run(ago(6));
    const r = await t.admin('GET', '/api/articles');
    assert.equal(r.status, 401, '6 min de 5: se bloquea');
    assert.equal(r.data.locked, true);
    assert.equal((await t.admin('GET', '/api/auth/me')).data.locked, true, 'al reabrir la pestaña también aparece bloqueada');

    assert.equal((await t.admin('POST', '/api/auth/unlock', { secret: PW })).status, 200);
    t.db.prepare('UPDATE user_sessions SET last_seen = ?').run(ago(4));
    await t.admin('POST', '/api/auth/ping', {}); // actividad: renueva el reloj
    const seen = t.db.prepare('SELECT last_seen FROM user_sessions').get().last_seen;
    assert.ok(new Date(seen.replace(' ', 'T')).getTime() > Date.now() - 30_000, 'el aviso de actividad renueva la última actividad');

    assert.equal((await set(0)).data.idleLockMinutes, 0);
    t.db.prepare('UPDATE user_sessions SET last_seen = ?').run(ago(600));
    assert.equal((await t.admin('GET', '/api/articles')).status, 200, 'apagado: no bloquea');
  } finally { t.close(); }
});

test('ajustes de seguridad: solo administradores y con valores válidos', async () => {
  const t = await start();
  try {
    await addUser(t, 'ana', 'clave-ana-123');
    const ana = t.client(); await login(ana, 'ana', 'clave-ana-123');
    assert.equal((await ana.call('GET', '/api/security')).status, 403);
    assert.equal((await ana.call('PUT', '/api/security', { loginOnStart: false })).status, 403);

    assert.equal((await t.admin('PUT', '/api/security', { idleLockMinutes: 7 })).status, 400);
    assert.equal((await t.admin('PUT', '/api/security', { idleLockMinutes: -1 })).status, 400);
    assert.equal((await t.admin('PUT', '/api/security', { loginOnStart: 'si' })).status, 400);
    const ok = await t.admin('PUT', '/api/security', { loginOnStart: true, idleLockMinutes: 10 });
    assert.deepEqual(ok.data, { loginOnStart: true, idleLockMinutes: 10 });

    // Todos los usuarios reciben la configuración del bloqueo (la pantalla la necesita); no pueden cambiarla
    assert.equal((await ana.call('GET', '/api/auth/me')).data.security.idleLockMinutes, 10);
    assert.equal((await t.client().call('GET', '/api/auth/me')).data.security, undefined, 'sin sesión no se muestra nada');
  } finally { t.close(); }
});

test('pedir inicio de sesión al abrir: la cookie dura lo que el navegador y se cierran las sesiones al arrancar', async () => {
  const t = await start();
  try {
    const c = t.client();
    const a = await login(c, 'admin', PW);
    assert.doesNotMatch(a.setCookie, /Max-Age/, 'por defecto muere al cerrar el navegador');
    assert.match(a.setCookie, /HttpOnly/);

    await t.admin('PUT', '/api/security', { loginOnStart: false });
    assert.match((await login(t.client(), 'admin', PW)).setCookie, /Max-Age=\d+/, 'desactivado: la sesión se conserva');

    // Al arrancar el programa
    assert.ok(t.db.prepare('SELECT COUNT(*) n FROM user_sessions').get().n > 0);
    assert.equal(clearSessionsIfRequired(t.db), false, 'desactivado: las sesiones quedan');
    assert.ok(t.db.prepare('SELECT COUNT(*) n FROM user_sessions').get().n > 0);
    await t.admin('PUT', '/api/security', { loginOnStart: true });
    assert.equal(clearSessionsIfRequired(t.db), true);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM user_sessions').get().n, 0, 'activado: hay que iniciar sesión de nuevo');
    assert.equal((await t.admin('GET', '/api/articles')).status, 401);
  } finally { t.close(); }
});

test('el administrador puede quitar el PIN de otro usuario que lo olvidó', async () => {
  const t = await start();
  try {
    const id = await addUser(t, 'ana', 'clave-ana-123');
    const ana = t.client(); await login(ana, 'ana', 'clave-ana-123');
    assert.equal((await ana.call('POST', '/api/auth/pin', { current: 'clave-ana-123', pin: '7391' })).status, 200);
    assert.equal((await t.admin('GET', '/api/users')).data.find((u) => u.id === id).has_pin, 1);
    assert.equal((await login(t.client(), 'ana', '7391')).status, 200);

    assert.equal((await t.admin('PUT', `/api/users/${id}`, { clear_pin: true })).status, 200);
    assert.equal((await t.admin('GET', '/api/users')).data.find((u) => u.id === id).has_pin, 0);
    assert.equal((await login(t.client(), 'ana', '7391')).status, 401);
    assert.equal((await login(t.client(), 'ana', 'clave-ana-123')).status, 200, 'su contraseña sigue igual');
  } finally { t.close(); }
});

test('los bloqueos por error crecen y los PIN triviales se detectan', () => {
  let ms = 0;
  const lim = createLimiter({ max: 2, lockMs: 1000, maxLockMs: 10_000, now: () => ms });
  const spend = () => { lim.fail('k'); lim.fail('k'); return lim.check('k'); };
  assert.equal(spend(), 1, '1.er bloqueo: 1 s');
  ms += 1500; assert.equal(lim.check('k'), 0, 'pasado el tiempo se puede reintentar');
  assert.equal(spend(), 5, '2.º bloqueo: 5 s');
  ms += 6000;
  assert.equal(spend(), 10, '3.º: 25 s, pero con tope de 10 s en esta prueba');
  lim.ok('k');
  assert.equal(spend(), 1, 'tras entrar bien, vuelve a empezar');

  for (const p of ['0000', '1111', '1234', '2345', '4321', '9876', '123456', '8888888']) assert.equal(isWeakPin(p), true, p);
  for (const p of ['4821', '1357', '2468', '1212', '7391', '102938']) assert.equal(isWeakPin(p), false, p);
  assert.ok(PIN_RE.test('1234') && PIN_RE.test('12345678') && !PIN_RE.test('123') && !PIN_RE.test('123456789') && !PIN_RE.test('12a4'));
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('192.168.1.5') && !isLoopback(undefined));
});
