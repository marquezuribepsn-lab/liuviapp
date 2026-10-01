import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

async function start() {
  const server = createServer(createApp(openDb(':memory:')));
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  return { call, close: () => server.close() };
}

test('flujo completo: artículos, caja, venta, anulación y estadísticas', async () => {
  const { call, close } = await start();
  try {
    // Sin caja abierta no se puede vender
    const a = (await call('POST', '/api/articles', { barcode: '7791234567890', name: 'Remera lisa', size: 'M', color: 'Negro', price: 10000, cost: 4000, stock: 5, min_stock: 2 })).data;
    assert.equal(a.stock, 5);
    assert.equal((await call('POST', '/api/articles', { barcode: '7791234567890', name: 'Otra', price: 1 })).status, 400, 'código duplicado');
    assert.equal((await call('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 10000 }] })).status, 409);

    // Lector de código de barras
    assert.equal((await call('GET', '/api/articles/barcode/7791234567890')).data.name, 'Remera lisa');
    assert.equal((await call('GET', '/api/articles/barcode/000')).status, 404);

    // Abrir caja y vender con pago mixto + descuento
    await call('POST', '/api/cash/open', { amount: 5000 });
    assert.equal((await call('POST', '/api/cash/open', { amount: 1 })).status, 409);
    const sale = (await call('POST', '/api/sales', {
      items: [{ article_id: a.id, qty: 2 }], discount_pct: 10,
      payments: [{ method: 'tarjeta', amount: 8000 }, { method: 'efectivo', amount: 10000 }],
    })).data;
    assert.equal(sale.total, 18000);
    assert.equal(sale.change, 0);
    assert.equal((await call('GET', '/api/articles/barcode/7791234567890')).data.stock, 3);

    // Stock insuficiente y pago insuficiente
    assert.equal((await call('POST', '/api/sales', { items: [{ article_id: a.id, qty: 9 }], payments: [{ method: 'efectivo', amount: 1e6 }] })).status, 409);
    assert.equal((await call('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 100 }] })).status, 400);

    // Vuelto
    const s2 = (await call('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 12000 }] })).data;
    assert.equal(s2.change, 2000);

    // Egreso e ingreso manual
    await call('POST', '/api/cash/movement', { type: 'egreso', amount: 1500, method: 'efectivo', concept: 'Bolsas' });
    const cur = (await call('GET', '/api/cash/current')).data;
    // 5000 + 10000(efvo venta1) + 10000(venta2 neto) - 1500
    assert.equal(cur.expected_cash_now, 23500);
    assert.equal(cur.byMethod.tarjeta.neto, 8000);

    // Anulación: vuelve el stock y sale la plata
    await call('POST', `/api/sales/${s2.id}/void`);
    assert.equal((await call('POST', `/api/sales/${s2.id}/void`)).status, 409);
    assert.equal((await call('GET', '/api/articles/barcode/7791234567890')).data.stock, 3);
    assert.equal((await call('GET', '/api/cash/current')).data.expected_cash_now, 13500);

    // Estadísticas
    for (const g of ['day', 'week', 'month', 'year']) {
      const series = (await call('GET', `/api/stats/series?group=${g}`)).data;
      assert.equal(series.length, 1);
      assert.equal(series[0].total, 18000);
      assert.equal(series[0].profit, 18000 - 8000);
    }
    const br = (await call('GET', '/api/stats/breakdown?group=month')).data;
    assert.equal(br.total, 18000);
    assert.equal(br.topArticles[0].units, 2);

    // Ajuste de stock y alerta de stock bajo
    assert.equal((await call('POST', '/api/stock/adjust', { article_id: a.id, qty: -5 })).status, 400);
    await call('POST', '/api/stock/adjust', { article_id: a.id, qty: -2, reason: 'ajuste' });
    assert.equal((await call('GET', '/api/articles?low=1')).data.length, 1);

    // Cierre con diferencia
    const closed = (await call('POST', '/api/cash/close', { counted: 13000 })).data;
    assert.equal(closed.expected_cash, 13500);
    assert.equal(closed.difference, -500);
    assert.equal((await call('GET', '/api/cash/current')).data, null);
  } finally { close(); }
});
