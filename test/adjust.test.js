import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('descuento y recargo, cada uno por monto o por porcentaje', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Vestido', price: 10000, cost: 4000, stock: 20 })).data;
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    const venta = (adj, pay) => t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'efectivo', amount: pay }], ...adj });
    const ok = async (adj, pay, esperado) => {
      const r = await venta(adj, pay);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.total, esperado, JSON.stringify(adj));
      return r.data;
    };
    await ok({}, 10000, 10000);
    await ok({ discount_amount: 2000 }, 8000, 8000);
    await ok({ discount_pct: 10 }, 9000, 9000);
    await ok({ discount_pct: 10, discount_amount: 500 }, 9500, 9500);                       // si hay monto, manda el monto
    const rec = await ok({ surcharge_pct: 10 }, 11000, 11000);
    assert.equal(rec.surcharge, 1000); assert.equal(rec.discount, 0);
    await ok({ surcharge_amount: 700 }, 10700, 10700);
    const both = await ok({ discount_pct: 10, surcharge_pct: 10 }, 9900, 9900);              // el recargo va sobre lo que queda tras el descuento
    assert.equal(both.discount, 1000); assert.equal(both.surcharge, 900);
    await ok({ discount_amount: 1000, surcharge_amount: 400 }, 9400, 9400);
    // Guardado en la venta
    const g = (await t.admin('GET', '/api/sales')).data.find((s) => s.id === both.id);
    assert.equal(g.subtotal, 10000); assert.equal(g.discount, 1000); assert.equal(g.surcharge, 900); assert.equal(g.total, 9900);
    // Inválidos
    assert.equal((await venta({ discount_amount: 10001 }, 10000)).status, 400, 'el descuento no supera el subtotal');
    assert.equal((await venta({ discount_pct: 101 }, 10000)).status, 400);
    assert.equal((await venta({ surcharge_pct: 101 }, 10000)).status, 400);
    assert.equal((await venta({ discount_amount: -5 }, 10000)).status, 400);
    assert.equal((await venta({ surcharge_amount: 'x' }, 10000)).status, 400);
    assert.equal((await venta({ surcharge_pct: 10 }, 10000)).status, 400, 'falta cobrar el recargo');
    // Estadísticas: el total incluye el recargo
    const total = (await t.admin('GET', '/api/stats/series?group=day')).data.at(-1).total;
    assert.equal(total, 10000 + 8000 + 9000 + 9500 + 11000 + 10700 + 9900 + 9400);
    // Devolver una prenda de una venta con recargo devuelve lo que se pagó (con el recargo)
    const it = (await t.admin('GET', '/api/sales')).data.find((s) => s.id === rec.id).items[0].id;
    const dev = await t.admin('POST', '/api/returns', { sale_id: rec.id, items: [{ sale_item_id: it, qty: 1 }], leftover: 'efectivo' });
    assert.equal(dev.data.value, 11000);
  } finally { t.close(); }
});

test('la venta en espera guarda y devuelve sus descuentos y recargos', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Vestido', price: 10000, cost: 4000, stock: 20 })).data;
    const h = await t.admin('POST', '/api/held', { items: [{ article_id: a.id, qty: 2 }], adjust: { discount_amount: 2000, surcharge_pct: 10 } });
    assert.equal(h.status, 201);
    assert.equal(h.data.total, 19800, '20000 − 2000 = 18000, +10 % = 19800');
    const r = (await t.admin('GET', `/api/held/${h.data.id}`)).data;
    assert.deepEqual(r.adjust, { discount_pct: 0, discount_amount: 2000, surcharge_pct: 10, surcharge_amount: 0 });
    // compatibilidad: solo discount_pct
    const h2 = await t.admin('POST', '/api/held', { items: [{ article_id: a.id, qty: 1 }], discount_pct: 10 });
    assert.equal(h2.data.total, 9000);
    assert.equal((await t.admin('POST', '/api/held', { items: [{ article_id: a.id, qty: 1 }], adjust: { discount_pct: 500 } })).status, 400);
  } finally { t.close(); }
});
