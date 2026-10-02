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

test('lector de códigos: el código se encuentra aunque venga en otras mayúsculas o sin ceros iniciales', async () => {
  const t = await start();
  try {
    const mk = (o) => t.admin('POST', '/api/articles', { price: 1000, cost: 1, stock: 3, ...o });
    await mk({ name: 'Remera', barcode: '7790001000011' });
    await mk({ name: 'Short', barcode: 'ABC-123' });
    await mk({ name: 'Top', barcode: '0123456789012' });
    const get = async (c) => (await t.admin('GET', '/api/articles/barcode/' + encodeURIComponent(c)));
    assert.equal((await get('7790001000011')).data.name, 'Remera');
    assert.equal((await get('abc-123')).data.name, 'Short', 'bloqueo de mayúsculas del lector');
    assert.equal((await get(' ABC-123 ')).data.name, 'Short');
    assert.equal((await get('123456789012')).data.name, 'Top', 'UPC-A leído sin el cero inicial');
    assert.equal((await get('999')).status, 404);
    assert.equal((await get('0')).status, 404, 'el cero solo no coincide con todo');
    // si dos artículos serían igual de válidos, no se adivina
    await mk({ name: 'Top 2', barcode: '000123456789012' });
    assert.equal((await get('123456789012')).status, 404);
    assert.equal((await get('0123456789012')).data.name, 'Top', 'el exacto siempre gana');
  } finally { t.close(); }
});
