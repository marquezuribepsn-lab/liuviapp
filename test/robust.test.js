import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start } from './helpers.js';

const rawGet = (base, path) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

test('direcciones raras o rotas no tiran abajo el servidor', async () => {
  const t = await start();
  try {
    for (const path of ['//', '/%', '/api/%E0%A4%A', '/../../etc/passwd', '/api/articles/%00', '//evil.com/x']) {
      const r = await rawGet(t.base, path);
      assert.ok(r.status >= 200 && r.status < 500, `${path} → ${r.status}`);
    }
    assert.equal((await rawGet(t.base, '//')).status, 400, 'la dirección inválida se rechaza con un 400');
    // El servidor sigue respondiendo después de todo eso
    assert.equal((await t.client().call('GET', '/api/auth/me')).status, 200);
  } finally { t.close(); }
});

test('seguridad: cabeceras, host permitido y límites numéricos', async () => {
  const t = await start();
  try {
    const r = await fetch(t.base + '/');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    // Un dominio distinto (DNS rebinding) no es atendido
    const u = new URL(t.base);
    const evil = await new Promise((resolve) => http.get({ host: u.hostname, port: u.port, path: '/api/auth/me', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(evil, 403);
    const ok = await new Promise((resolve) => http.get({ host: u.hostname, port: u.port, path: '/api/auth/me', headers: { host: `localhost:${u.port}` } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(ok, 200);
    // Números absurdos se rechazan en lugar de romper los totales
    const a = (await t.admin('POST', '/api/articles', { name: 'X', price: 10, stock: 5 })).data;
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    assert.equal((await t.admin('POST', '/api/articles', { name: 'Caro', price: 1e300 })).status, 400);
    assert.equal((await t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1e15 }], payments: [{ method: 'efectivo', amount: 10 }] })).status, 400);
    assert.equal((await t.admin('POST', '/api/sales', { items: [{ qty: 1 }], payments: [{ method: 'efectivo', amount: 10 }] })).status, 400, 'artículo sin id: error del pedido, no 500');
  } finally { t.close(); }
});

test('modo red: con HOST abierto se aceptan otras direcciones', async () => {
  const t = await start({ lan: true });
  try {
    const u = new URL(t.base);
    const code = await new Promise((resolve) => http.get({ host: u.hostname, port: u.port, path: '/api/auth/me', headers: { host: '192.168.1.20:3000' } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(code, 200);
  } finally { t.close(); }
});
