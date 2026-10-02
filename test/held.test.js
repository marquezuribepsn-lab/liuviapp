import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('ventas en espera: guardar, listar, retomar con precios actuales, reemplazar, descartar y cobrar', async () => {
  const t = await start();
  try {
    const mk = async (o) => (await t.admin('POST', '/api/articles', { cost: 4000, stock: 10, ...o })).data;
    const vestido = await mk({ name: 'Vestido', price: 10000 });
    const top = await mk({ name: 'Top', price: 7000 });
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    const cli = (await t.admin('POST', '/api/customers', { name: 'Ana Pérez' })).data;

    assert.equal((await t.admin('POST', '/api/held', { items: [] })).status, 400);
    assert.equal((await t.admin('POST', '/api/held', { items: [{ article_id: 999, qty: 1 }] })).status, 404);
    assert.equal((await t.admin('POST', '/api/held', { items: [{ article_id: vestido.id, qty: 0 }] })).status, 400);

    const h = await t.admin('POST', '/api/held', { label: 'Señora del abrigo', customer_id: cli.id, discount_pct: 10, items: [{ article_id: vestido.id, qty: 2 }, { article_id: top.id, qty: 1 }] });
    assert.equal(h.status, 201);
    assert.equal(h.data.units, 3); assert.equal(h.data.total, 24300, '27000 con 10 % de descuento');
    assert.equal(h.data.customer_name, 'Ana Pérez');
    assert.equal((await t.admin('GET', '/api/held')).data.length, 1);
    assert.equal((await t.admin('GET', '/api/articles?all=1')).data.find((a) => a.id === vestido.id).stock, 10, 'esperar no toca el stock');

    // Cambian los precios y el stock mientras tanto: al retomar se ve lo de ahora
    await t.admin('PUT', `/api/articles/${vestido.id}`, { name: 'Vestido', price: 12000 });
    const r = (await t.admin('GET', `/api/held/${h.data.id}`)).data;
    assert.equal(r.items.find((i) => i.article.name === 'Vestido').article.price, 12000);
    assert.equal(r.customer.id, cli.id); assert.equal(r.discount_pct, 10); assert.equal(r.missing, 0);
    // Un artículo dado de baja se avisa y se omite
    await t.admin('DELETE', `/api/articles/${top.id}`);
    const r2 = (await t.admin('GET', `/api/held/${h.data.id}`)).data;
    assert.equal(r2.items.length, 1); assert.equal(r2.missing, 1);

    // Volver a ponerla en espera reemplaza la anterior
    const h2 = await t.admin('POST', '/api/held', { replace_id: h.data.id, items: [{ article_id: vestido.id, qty: 1 }] });
    assert.equal(h2.status, 201);
    const lista = (await t.admin('GET', '/api/held')).data;
    assert.equal(lista.length, 1); assert.equal(lista[0].id, h2.data.id);
    assert.equal((await t.admin('GET', `/api/held/${h.data.id}`)).status, 404);

    // Cobrarla la saca de la lista; si falla el cobro, queda
    const mal = await t.admin('POST', '/api/sales', { items: [{ article_id: vestido.id, qty: 1 }], held_id: h2.data.id, payments: [{ method: 'efectivo', amount: 1 }] });
    assert.equal(mal.status, 400);
    assert.equal((await t.admin('GET', '/api/held')).data.length, 1, 'el cobro rechazado no borra la venta en espera');
    const ok = await t.admin('POST', '/api/sales', { items: [{ article_id: vestido.id, qty: 1 }], held_id: h2.data.id, payments: [{ method: 'efectivo', amount: 12000 }] });
    assert.equal(ok.status, 201);
    assert.equal((await t.admin('GET', '/api/held')).data.length, 0);

    // Descartar
    const h3 = (await t.admin('POST', '/api/held', { items: [{ article_id: vestido.id, qty: 1 }] })).data;
    assert.equal((await t.admin('DELETE', `/api/held/${h3.id}`)).status, 200);
    assert.equal((await t.admin('GET', '/api/held')).data.length, 0);
  } finally { t.close(); }
});

test('ventas en espera: permiso y límite', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Vestido', price: 10000, cost: 1, stock: 5 })).data;
    const sin = (await t.admin('POST', '/api/roles', { name: 'Depósito', permissions: ['stock.ver'] })).data;
    await t.admin('POST', '/api/users', { username: 'leo', name: 'Leo', password: 'clave-leo-1234', role_id: sin.id });
    const leo = t.client(); await leo.call('POST', '/api/auth/login', { username: 'leo', password: 'clave-leo-1234' });
    assert.equal((await leo.call('GET', '/api/held')).status, 403);
    assert.equal((await leo.call('POST', '/api/held', { items: [{ article_id: a.id, qty: 1 }] })).status, 403);
    for (let i = 0; i < 50; i++) assert.equal((await t.admin('POST', '/api/held', { items: [{ article_id: a.id, qty: 1 }] })).status, 201);
    const tope = await t.admin('POST', '/api/held', { items: [{ article_id: a.id, qty: 1 }] });
    assert.equal(tope.status, 409); assert.match(tope.data.error, /demasiadas/);
  } finally { t.close(); }
});
