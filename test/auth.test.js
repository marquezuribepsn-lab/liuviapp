import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('sin sesión no se accede a la API; el setup crea el primer admin una sola vez', async () => {
  const t = await start();
  try {
    const anon = t.client();
    assert.equal((await anon.call('GET', '/api/articles')).status, 401);
    assert.equal((await anon.call('GET', '/api/users')).status, 401);
    const me = (await anon.call('GET', '/api/auth/me')).data;
    assert.equal(me.user, null);
    assert.equal(me.setupNeeded, false); // el helper ya creó al admin
    assert.equal((await anon.call('POST', '/api/auth/setup', { username: 'otro', password: 'clave-segura-1' })).status, 409);
  } finally { t.close(); }
});

test('setup inicial: pide contraseña de 8+ caracteres y deja la sesión iniciada', async () => {
  const { createServer } = await import('node:http');
  const { openDb } = await import('../db.js');
  const { createApp } = await import('../app.js');
  const server = createServer(createApp(openDb(':memory:')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b, c) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(c && { Cookie: c }) }, body: JSON.stringify(b) });
  try {
    assert.equal((await (await fetch(base + '/api/auth/me')).json()).setupNeeded, true);
    assert.equal((await post('/api/auth/setup', { username: 'ab', password: 'clave-segura-1' })).status, 400);
    assert.equal((await post('/api/auth/setup', { username: 'dueño', password: 'corta' })).status, 400);
    const ok = await post('/api/auth/setup', { username: 'dueño', name: 'La dueña', password: 'clave-segura-1' });
    assert.equal(ok.status, 201);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const me = await (await fetch(base + '/api/auth/me', { headers: { Cookie: cookie.split(';')[0] } })).json();
    assert.equal(me.user.role, 'Administrador');
    assert.equal(me.user.permissions.includes('usuarios.admin'), true);
  } finally { server.close(); }
});

test('login, logout y contraseña: hash en base, mensajes genéricos y bloqueo por intentos', async () => {
  const t = await start();
  try {
    const row = t.db.prepare("SELECT password_hash FROM users WHERE username='admin'").get();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes('clave-segura-1'));

    const c = t.client();
    const badUser = await c.call('POST', '/api/auth/login', { username: 'nadie', password: 'x' });
    const badPass = await c.call('POST', '/api/auth/login', { username: 'admin', password: 'x' });
    assert.equal(badUser.status, 401);
    assert.equal(badPass.status, 401);
    assert.equal(badUser.data.error, badPass.data.error); // no revela si el usuario existe

    assert.equal((await c.call('POST', '/api/auth/login', { username: 'ADMIN', password: 'clave-segura-1' })).status, 200);
    assert.equal((await c.call('GET', '/api/articles')).status, 200);
    await c.call('POST', '/api/auth/logout', {});
    assert.equal((await c.call('GET', '/api/articles')).status, 401);

    // 5 errores seguidos bloquean aunque después venga la clave correcta
    const l = t.client();
    for (let i = 0; i < 5; i++) await l.call('POST', '/api/auth/login', { username: 'admin', password: 'mal' });
    assert.equal((await l.call('POST', '/api/auth/login', { username: 'admin', password: 'clave-segura-1' })).status, 429);
  } finally { t.close(); }
});

test('cambio de contraseña: exige la actual y cierra las otras sesiones', async () => {
  const t = await start();
  try {
    const other = t.client();
    await other.call('POST', '/api/auth/login', { username: 'admin', password: 'clave-segura-1' });
    assert.equal((await t.admin('POST', '/api/auth/password', { current: 'incorrecta', next: 'nueva-clave-22' })).status, 403);
    assert.equal((await t.admin('POST', '/api/auth/password', { current: 'clave-segura-1', next: 'corta' })).status, 400);
    assert.equal((await t.admin('POST', '/api/auth/password', { current: 'clave-segura-1', next: 'nueva-clave-22' })).status, 200);
    assert.equal((await t.admin('GET', '/api/articles')).status, 200, 'la sesión actual sigue abierta');
    assert.equal((await other.call('GET', '/api/articles')).status, 401, 'la otra sesión se cerró');
    assert.equal((await t.client().call('POST', '/api/auth/login', { username: 'admin', password: 'nueva-clave-22' })).status, 200);
  } finally { t.close(); }
});

test('el vendedor tiene permisos limitados y el admin puede cambiarlos al instante', async () => {
  const t = await start();
  try {
    const roles = (await t.admin('GET', '/api/roles')).data;
    const vend = roles.find((r) => r.name === 'Vendedor');
    assert.equal(roles.find((r) => r.is_admin).permissions.length, (await t.admin('GET', '/api/auth/me')).data.permissions.length);
    const u = await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: vend.id });
    assert.equal(u.status, 201);
    assert.equal((await t.admin('POST', '/api/users', { username: 'ANA', name: 'Otra', password: 'clave-ana-123', role_id: vend.id })).status, 400, 'usuario duplicado sin distinguir mayúsculas');

    const art = (await t.admin('POST', '/api/articles', { barcode: '111', name: 'Remera', size: 'M', price: 1000, cost: 400, stock: 5 })).data;
    await t.admin('POST', '/api/cash/open', { amount: 100 });

    const ana = t.client();
    assert.equal((await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' })).status, 200);
    // Puede ver artículos (sin costo) y vender
    const list = (await ana.call('GET', '/api/articles')).data;
    assert.equal(list.length, 1);
    assert.equal('cost' in list[0], false, 'el vendedor no ve costos');
    assert.equal('cost' in (await ana.call('GET', '/api/articles/barcode/111')).data, false);
    const sale = await ana.call('POST', '/api/sales', { items: [{ article_id: art.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 1000 }] });
    assert.equal(sale.status, 201);
    // No puede lo demás
    for (const [m, path, body] of [
      ['POST', '/api/articles', { name: 'x', price: 1 }], ['PUT', `/api/articles/${art.id}`, { price: 1 }], ['DELETE', `/api/articles/${art.id}`],
      ['POST', '/api/stock/adjust', { article_id: art.id, qty: 1 }], ['POST', `/api/sales/${sale.data.id}/void`, {}],
      ['POST', '/api/cash/close', { counted: 0 }], ['POST', '/api/cash/movement', { type: 'egreso', amount: 1, concept: 'x' }],
      ['GET', '/api/cash/sessions'], ['GET', '/api/stats/series'], ['GET', '/api/users'], ['GET', '/api/roles'],
      ['POST', '/api/users', {}], ['POST', '/api/roles', {}],
    ]) assert.equal((await ana.call(m, path, body)).status, 403, `${m} ${path}`);
    // Ve que la caja está abierta pero no cuánto efectivo hay
    const cur = (await ana.call('GET', '/api/cash/current')).data;
    assert.equal(cur.id > 0, true);
    assert.equal('expected_cash_now' in cur, false);
    // El stock sin costos
    assert.equal((await ana.call('GET', '/api/stock/summary')).data.cost_value, null);

    // El admin le da permisos al rol: rige en la sesión que ya estaba abierta
    const perms = [...vend.permissions, 'ventas.anular', 'estadisticas.ver'];
    assert.equal((await t.admin('PUT', `/api/roles/${vend.id}`, { name: 'Vendedor', permissions: perms })).status, 200);
    assert.equal((await ana.call('POST', `/api/sales/${sale.data.id}/void`, {})).status, 200);
    await ana.call('POST', '/api/sales', { items: [{ article_id: art.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 1000 }] });
    const series = (await ana.call('GET', '/api/stats/series?group=day')).data;
    assert.equal(series[0].profit, null, 'sin costos.ver no ve la ganancia');
    // La venta quedó a nombre de Ana
    const sales = (await t.admin('GET', '/api/sales')).data;
    assert.equal(sales.every((x) => x.seller === 'Ana'), true);
    // Y se puede quitar
    await t.admin('PUT', `/api/roles/${vend.id}`, { name: 'Vendedor', permissions: ['articulos.ver'] });
    assert.equal((await ana.call('POST', '/api/sales', { items: [{ article_id: art.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 1000 }] })).status, 403);
  } finally { t.close(); }
});

test('roles nuevos, protecciones del admin y desactivación de usuarios', async () => {
  const t = await start();
  try {
    const roles = (await t.admin('GET', '/api/roles')).data;
    const adminRole = roles.find((r) => r.is_admin);
    const me = (await t.admin('GET', '/api/auth/me')).data.user;
    // Rol personalizado
    const gerente = (await t.admin('POST', '/api/roles', { name: 'Gerente', permissions: ['ventas.cobrar', 'estadisticas.ver', 'costos.ver'] })).data;
    assert.equal((await t.admin('POST', '/api/roles', { name: 'gerente', permissions: [] })).status, 400, 'nombre duplicado');
    assert.equal((await t.admin('POST', '/api/roles', { name: 'Raro', permissions: ['hackear'] })).status, 400, 'permiso inexistente');
    // El rol Administrador es intocable
    assert.equal((await t.admin('PUT', `/api/roles/${adminRole.id}`, { name: 'X', permissions: [] })).status, 400);
    assert.equal((await t.admin('DELETE', `/api/roles/${adminRole.id}`)).status, 400);
    // No se puede dejar el sistema sin administradores ni autodesactivarse
    assert.equal((await t.admin('PUT', `/api/users/${me.id}`, { active: false })).status, 400);
    const u2 = (await t.admin('POST', '/api/users', { username: 'gero', name: 'Gero', password: 'clave-gero-12', role_id: gerente.id })).data;
    assert.equal((await t.admin('PUT', `/api/users/${me.id}`, { role_id: gerente.id })).status, 400, 'no puede quitarse a sí mismo el único admin');
    // Un rol en uso no se borra; vacío sí
    assert.equal((await t.admin('DELETE', `/api/roles/${gerente.id}`)).status, 409);
    const vacio = (await t.admin('POST', '/api/roles', { name: 'Temporal', permissions: [] })).data;
    assert.equal((await t.admin('DELETE', `/api/roles/${vacio.id}`)).status, 200);
    // Sacar usuarios.admin de un rol con el único admin restante se rechaza
    const adm2 = (await t.admin('POST', '/api/roles', { name: 'Admin2', permissions: ['usuarios.admin'] })).data;
    await t.admin('PUT', `/api/users/${u2.id}`, { role_id: adm2.id });
    assert.equal((await t.admin('PUT', `/api/roles/${adm2.id}`, { permissions: [] })).status, 200, 'queda el admin original');

    // Desactivar corta las sesiones y bloquea el login; reactivar y resetear clave lo devuelve
    const g = t.client();
    await g.call('POST', '/api/auth/login', { username: 'gero', password: 'clave-gero-12' });
    assert.equal((await g.call('GET', '/api/articles')).status, 403, 'sin permiso de artículos');
    await t.admin('PUT', `/api/users/${u2.id}`, { active: false });
    assert.equal((await g.call('GET', '/api/auth/me')).data.user, null);
    assert.equal((await t.client().call('POST', '/api/auth/login', { username: 'gero', password: 'clave-gero-12' })).status, 401);
    await t.admin('PUT', `/api/users/${u2.id}`, { active: true, password: 'otra-clave-123' });
    assert.equal((await t.client().call('POST', '/api/auth/login', { username: 'gero', password: 'otra-clave-123' })).status, 200);
  } finally { t.close(); }
});

test('las escrituras exigen JSON (defensa CSRF)', async () => {
  const t = await start();
  try {
    const c = t.client();
    await c.call('POST', '/api/auth/login', { username: 'admin', password: 'clave-segura-1' });
    const r = await c.call('POST', '/api/articles', { name: 'x', price: 1 }, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 400);
  } finally { t.close(); }
});
