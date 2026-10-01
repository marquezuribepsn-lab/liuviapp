import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('la venta guarda y devuelve los datos del cliente (opcionales y acotados)', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Remera', price: 1000, cost: 400, stock: 9 })).data;
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    const venta = (over) => t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 1000 }], ...over });
    assert.equal((await venta({ customer_name: '  Ana Pérez ', customer_doc: '20-12345678-9' })).status, 201);
    assert.equal((await venta({ customer_name: 'x'.repeat(500) })).status, 201);
    assert.equal((await venta({})).status, 201);
    const list = (await t.admin('GET', '/api/sales')).data; // más nueva primero
    assert.equal(list[2].customer_name, 'Ana Pérez');
    assert.equal(list[2].customer_doc, '20-12345678-9');
    assert.equal(list[1].customer_name.length, 120);
    assert.equal(list[0].customer_name, '');
  } finally { t.close(); }
});
