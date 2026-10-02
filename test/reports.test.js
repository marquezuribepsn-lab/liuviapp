import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';
import { readSheet } from '../xlsx.js';

test('reportes: contenido, totales, permisos y Excel descargable', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Remera', brand: 'Koxis', price: 1000, cost: 400, stock: 10, min_stock: 1 })).data;
    await t.admin('POST', '/api/articles', { name: 'Jean', brand: 'Adicta', price: 3000, cost: 1000, stock: 4 });
    await t.admin('POST', '/api/cash/open', { amount: 100 });
    const s1 = (await t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 3 }], payments: [{ method: 'efectivo', amount: 3000 }] })).data;
    await t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'tarjeta', amount: 1000 }] });
    const v = (await t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 1000 }] })).data;
    await t.admin('POST', `/api/sales/${v.id}/void`, {});
    const ret = await t.admin('POST', '/api/returns', { sale_id: s1.id, items: [{ sale_item_id: (await t.admin('GET', '/api/sales')).data.find((x) => x.id === s1.id).items[0].id, qty: 1 }], leftover: 'efectivo' });
    assert.equal(ret.status, 201);

    const ventas = (await t.admin('GET', '/api/reports/ventas')).data;
    assert.equal(ventas.rows.length, 3);
    assert.equal(ventas.totals[12], 4000, 'total sin la anulada');
    assert.equal(ventas.totals[13], 1000, 'devuelto');
    assert.equal(ventas.rows.find((r) => r[14] === 'Anulada')[0], v.id);

    const arts = (await t.admin('GET', '/api/reports/articulos')).data;
    assert.equal(arts.rows[0][2], 3, 'unidades netas de devoluciones: 4 vendidas - 1 devuelta');
    assert.equal(arts.columns.at(-1).label, 'Ganancia');
    const marcas = (await t.admin('GET', '/api/reports/marcas')).data;
    assert.equal(marcas.rows[0][0], 'Koxis');
    const caja = (await t.admin('GET', '/api/reports/caja')).data;
    assert.equal(caja.rows.length, 1);
    assert.equal(caja.rows[0][2], 'Abierta');
    const stock = (await t.admin('GET', '/api/reports/stock')).data;
    assert.equal(stock.rows.length, 2);
    assert.equal((await t.admin('GET', '/api/reports/vendedores')).data.rows.length, 1);
    assert.equal((await t.admin('GET', '/api/reports/clientes')).data.rows.length, 0);

    assert.equal((await t.admin('GET', '/api/reports/ventas?from=2026-02-30x')).status, 400);
    assert.equal((await t.admin('GET', '/api/reports/ventas?from=2026-05-02&to=2026-05-01')).status, 400);
    assert.equal((await t.admin('GET', '/api/reports/inexistente')).status, 404);

    const x = await t.adminRaw('GET', '/api/reports/ventas/xlsx');
    assert.equal(x.status, 200);
    assert.match(x.headers.get('content-disposition'), /liuvi-ventas-.*\.xlsx/);
    const sheet = readSheet(x.buffer, 'x.xlsx');
    assert.equal(sheet.rows[0].cells[0], 'Liu Vi · Ventas (detalle)');
    assert.ok(sheet.rows.some((r) => r.cells.includes('Anulada')));

    // Vendedor sin permisos de reportes; un rol con solo stock.ver ve únicamente el de stock y sin costos
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.deepEqual((await ana.call('GET', '/api/reports')).data.map((k) => k.kind), ['stock', 'clientes']);
    assert.equal((await ana.call('GET', '/api/reports/ventas')).status, 403);
    const st = (await ana.call('GET', '/api/reports/stock')).data;
    assert.ok(!st.columns.some((c) => c.label.includes('Costo')), 'sin permiso de costos no se ven costos');
  } finally { t.close(); }
});
