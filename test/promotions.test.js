import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/promo.js';
import { start } from './helpers.js';

test('cálculo de ofertas: porcentaje, precio fijo, NxM y segunda unidad', () => {
  const P = globalThis.Promo;
  const L = [{ article_id: 1, price: 100, qty: 2 }, { article_id: 2, price: 50, qty: 1 }, { article_id: 3, price: 999, qty: 1 }];
  assert.equal(P.discountOf({ kind: 'percent', pct: 20, article_ids: [1] }, L), 40);
  assert.equal(P.discountOf({ kind: 'price', price: 80, article_ids: [1] }, L), 40);
  assert.equal(P.discountOf({ kind: 'nxm', buy: 2, pay: 1, article_ids: [1, 2] }, L), 100, '2x1: se regala la más barata de cada par');
  assert.equal(P.discountOf({ kind: 'nxm', buy: 3, pay: 2, article_ids: [1, 2] }, L), 50, '3x2 con 3 unidades: la más barata sale gratis');
  assert.equal(P.discountOf({ kind: 'nxm', buy: 2, pay: 1, article_ids: [2] }, L), 0, 'con una sola unidad no hay 2x1');
  assert.equal(P.discountOf({ kind: 'second', pct: 50, article_ids: [1, 2] }, L), 50);
  assert.equal(P.discountOf({ kind: 'percent', pct: 20, article_ids: [] }, L), 0);
  assert.equal(P.inForce({ active: 1, starts_on: '2026-01-01', ends_on: '2026-01-31' }, '2026-01-31'), true);
  assert.equal(P.inForce({ active: 1, starts_on: '2026-02-01', ends_on: null }, '2026-01-31'), false);
  assert.equal(P.inForce({ active: 0 }, '2026-01-31'), false);
});

test('ofertas: alta, validaciones, superposición y aplicación al vender', async () => {
  const t = await start();
  try {
    const mk = async (b) => (await t.admin('POST', '/api/articles', { stock: 10, ...b })).data;
    const a = await mk({ name: 'Remera', price: 10000, cost: 4000, barcode: 'R1' });
    const b = await mk({ name: 'Jean', price: 30000, cost: 12000, barcode: 'J1' });
    const c = await mk({ name: 'Top', price: 7000, cost: 2000, barcode: 'T1' });
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    const venta = (items, extra = {}) => t.admin('POST', '/api/sales', { items, payments: [{ method: 'efectivo', amount: 1e6 }], ...extra });

    // Validaciones
    assert.equal((await t.admin('POST', '/api/promotions', { name: '', kind: 'percent', pct: 10, article_ids: [a.id] })).status, 400);
    assert.equal((await t.admin('POST', '/api/promotions', { name: 'x', kind: 'percent', pct: 0, article_ids: [a.id] })).status, 400);
    assert.equal((await t.admin('POST', '/api/promotions', { name: 'x', kind: 'nxm', buy: 2, pay: 2, article_ids: [a.id] })).status, 400);
    assert.equal((await t.admin('POST', '/api/promotions', { name: 'x', kind: 'percent', pct: 10, article_ids: [] })).status, 400);
    assert.equal((await t.admin('POST', '/api/promotions', { name: 'x', kind: 'percent', pct: 10, article_ids: [9999] })).status, 404);
    assert.equal((await t.admin('POST', '/api/promotions', { name: 'x', kind: 'percent', pct: 10, starts_on: '2026-05-02', ends_on: '2026-05-01', article_ids: [a.id] })).status, 400);

    // 2x1 en remeras y jeans: 2 remeras + 1 jean → se regala una remera (la más barata del par jean+remera es la remera)
    const o1 = (await t.admin('POST', '/api/promotions', { name: '2x1 verano', kind: 'nxm', buy: 2, pay: 1, article_ids: [a.id, b.id] })).data;
    assert.equal(o1.article_ids.length, 2);
    assert.equal((await t.admin('POST', '/api/promotions', { name: 'otra', kind: 'percent', pct: 10, article_ids: [b.id] })).status, 409, 'un artículo no puede estar en dos ofertas activas');
    assert.equal((await t.admin('GET', '/api/promotions/active')).data.length, 1);

    // Listado con filtro «solo ofertas» y etiqueta de la oferta vigente
    const enOferta = (await t.admin('GET', '/api/articles?offers=1')).data;
    assert.deepEqual(enOferta.map((x) => x.id).sort(), [a.id, b.id].sort());
    assert.equal(enOferta[0].offer_name, '2x1 verano');
    assert.equal((await t.admin('GET', '/api/articles?offers=1&q=Jean')).data.length, 1);
    assert.equal((await t.admin('GET', '/api/articles')).data.find((x) => x.id === c.id).offer_name, null);

    const s1 = (await venta([{ article_id: a.id, qty: 2 }, { article_id: b.id, qty: 1 }])).data;
    // unidades: 30000, 10000, 10000 → grupo (30000,10000) paga 30000; sobra una remera sin pareja
    assert.equal(s1.promo_discount, 10000);
    assert.equal(s1.subtotal, 50000);
    assert.equal(s1.discount, 10000);
    assert.equal(s1.total, 40000);
    assert.equal(s1.promo_detail[0].name, '2x1 verano');

    // Descuento manual del 10 % va sobre lo que queda después de la oferta
    const s2 = (await venta([{ article_id: a.id, qty: 2 }], { discount_pct: 10 })).data;
    assert.equal(s2.promo_discount, 10000);
    assert.equal(s2.total, 9000, '20000 - 10000 de oferta = 10000; menos 10 % = 9000');
    assert.equal(s2.discount, 11000);

    // Devolver una remera de la venta con oferta devuelve lo realmente pagado, prorrateado
    const sale = (await t.admin('GET', '/api/sales')).data.find((x) => x.id === s2.id);
    const ret = await t.admin('POST', '/api/returns', { sale_id: s2.id, items: [{ sale_item_id: sale.items[0].id, qty: 1 }], leftover: 'efectivo' });
    assert.equal(ret.data.value, 4500);

    // Desactivar, editar con fechas vencidas y borrar
    await t.admin('PUT', `/api/promotions/${o1.id}`, { active: false });
    assert.equal((await t.admin('GET', '/api/articles?offers=1')).data.length, 0, 'una oferta desactivada no cuenta');
    assert.equal((await venta([{ article_id: a.id, qty: 2 }])).data.promo_discount, 0, 'oferta desactivada');
    const o2 = (await t.admin('POST', '/api/promotions', { name: 'Vence ayer', kind: 'percent', pct: 50, ends_on: '2000-01-01', article_ids: [a.id] })).data;
    assert.equal((await t.admin('GET', '/api/promotions/active')).data.length, 0, 'las vencidas no se aplican');
    await t.admin('PUT', `/api/promotions/${o2.id}`, { ends_on: null, pct: 30 });
    assert.equal((await venta([{ article_id: a.id, qty: 1 }])).data.promo_discount, 3000);
    assert.equal((await t.admin('PUT', `/api/promotions/${o1.id}`, { active: true })).status, 409, 'reactivarla chocaría con la otra');
    await t.admin('DELETE', `/api/promotions/${o2.id}`);
    assert.equal((await t.admin('PUT', `/api/promotions/${o1.id}`, { active: true })).status, 200);

    // Precio fijo y segunda unidad en otro artículo; las ventas en espera muestran el total con oferta
    await t.admin('POST', '/api/promotions', { name: 'Top a 5000', kind: 'price', price: 5000, article_ids: [c.id] });
    assert.equal((await venta([{ article_id: c.id, qty: 3 }])).data.total, 15000);
    const list = (await t.admin('GET', '/api/promotions')).data;
    assert.equal(list.length, 2);
    assert.ok(list[0].article_labels.length >= 1);

    // Permisos: el vendedor ve las vigentes pero no las crea
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('GET', '/api/promotions/active')).status, 200);
    assert.equal((await ana.call('POST', '/api/promotions', { name: 'x', kind: 'percent', pct: 10, article_ids: [a.id] })).status, 403);
  } finally { t.close(); }
});
