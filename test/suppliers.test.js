import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('proveedores y compras: suma stock, actualiza costo, deuda, pagos y caja', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Remera', price: 10000, cost: 4000, stock: 2 })).data;
    const b = (await t.admin('POST', '/api/articles', { name: 'Jean', price: 30000, cost: 12000, stock: 0 })).data;
    const art = async (id) => (await t.admin('GET', '/api/articles?all=1')).data.find((x) => x.id === id);

    const sup = (await t.admin('POST', '/api/suppliers', { name: 'Textil Sur', phone: '11 4444-5555' })).data;
    assert.equal((await t.admin('POST', '/api/suppliers', { name: 'textil sur' })).status, 409, 'nombre repetido');
    assert.equal((await t.admin('POST', '/api/suppliers', { name: '  ' })).status, 400);

    // Compra sin pagar: queda toda la deuda y entra el stock; con «actualizar costo» cambia el costo
    const c1 = await t.admin('POST', '/api/purchases', { supplier_id: sup.id, invoice: 'A-0001', update_cost: true,
      items: [{ article_id: a.id, qty: 10, cost: 4500 }, { article_id: b.id, qty: 5, cost: 13000 }] });
    assert.equal(c1.status, 201);
    assert.equal(c1.data.total, 110000);
    assert.equal(c1.data.owed, 110000);
    assert.equal((await art(a.id)).stock, 12);
    assert.equal((await art(a.id)).cost, 4500);
    assert.equal((await art(b.id)).stock, 5);

    // Segunda compra sin actualizar costo, pagando una parte desde la caja (exige caja abierta)
    const sinCaja = await t.admin('POST', '/api/purchases', { supplier_id: sup.id, items: [{ article_id: a.id, qty: 1, cost: 5000 }], paid_amount: 5000, from_cash: true });
    assert.equal(sinCaja.status, 409, 'sin caja abierta no se puede pagar desde la caja');
    assert.equal((await art(a.id)).stock, 12, 'y no queda nada a medias');
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    const c2 = await t.admin('POST', '/api/purchases', { supplier_id: sup.id, items: [{ article_id: a.id, qty: 2, cost: 5000 }], paid_amount: 4000, from_cash: true });
    assert.equal(c2.data.owed, 116000);
    assert.equal((await art(a.id)).cost, 4500, 'sin la opción, el costo no cambia');
    assert.equal((await t.admin('GET', '/api/cash/current')).data.byMethod.efectivo.egresos, 4000);
    assert.equal((await t.admin('POST', '/api/purchases', { supplier_id: sup.id, items: [{ article_id: a.id, qty: 1, cost: 100 }], paid_amount: 500 })).status, 400, 'no se puede pagar más que el total');

    // Pago posterior de la deuda: fuera de la caja (transferencia propia) y desde la caja
    assert.equal((await t.admin('POST', `/api/suppliers/${sup.id}/payment`, { amount: 999999 })).status, 400);
    assert.equal((await t.admin('POST', `/api/suppliers/${sup.id}/payment`, { amount: 16000 })).data.owed, 100000);
    assert.equal((await t.admin('POST', `/api/suppliers/${sup.id}/payment`, { amount: 1000, from_cash: true, method: 'efectivo' })).data.owed, 99000);
    assert.equal((await t.admin('GET', '/api/cash/current')).data.byMethod.efectivo.egresos, 5000);

    const det = (await t.admin('GET', `/api/suppliers/${sup.id}`)).data;
    assert.equal(det.owed, 99000);
    assert.equal(det.purchases.length, 2);
    assert.equal(det.purchases.at(-1).items.length, 2);
    assert.equal((await t.admin('GET', '/api/suppliers')).data[0].purchases_count, 2);

    // Reportes y panel
    const rc = (await t.admin('GET', '/api/reports/compras')).data;
    assert.equal(rc.rows.length, 2);
    assert.equal(rc.totals[5], 120000);
    assert.equal((await t.admin('GET', '/api/reports/proveedores')).data.rows[0][4], 99000);
    assert.deepEqual((await t.admin('GET', '/api/dashboard')).data.suppliers, { count: 1, total: 99000 });

    // Limpiar el stock borrando artículos no debe romperse con compras registradas
    await t.admin('POST', '/api/stock/clear', { mode: 'delete', confirm: 'LIMPIAR' });

    // Permisos: el vendedor no ve proveedores
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('GET', '/api/suppliers')).status, 403);
    assert.equal((await ana.call('POST', '/api/purchases', {})).status, 403);
  } finally { t.close(); }
});

test('compras: editar corrige stock y deuda; anular revierte y respeta lo ya vendido', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Remera', price: 10000, cost: 4000, stock: 0, barcode: 'R1' })).data;
    const b = (await t.admin('POST', '/api/articles', { name: 'Jean', price: 30000, cost: 12000, stock: 0, barcode: 'J1' })).data;
    const art = async (id) => (await t.admin('GET', '/api/articles?all=1')).data.find((x) => x.id === id);
    const sup = (await t.admin('POST', '/api/suppliers', { name: 'Textil Sur' })).data;
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    const owed = async () => (await t.admin('GET', `/api/suppliers/${sup.id}`)).data.owed;

    const c = (await t.admin('POST', '/api/purchases', { supplier_id: sup.id, invoice: 'A-1', items: [{ article_id: a.id, qty: 10, cost: 4000 }], paid_amount: 10000, from_cash: true })).data;
    assert.equal(await owed(), 30000);

    // Editar: más cantidad, otro costo, un artículo nuevo y la factura
    const ed = await t.admin('PUT', `/api/purchases/${c.id}`, { invoice: 'A-2', update_cost: true, items: [{ article_id: a.id, qty: 12, cost: 4500 }, { article_id: b.id, qty: 2, cost: 13000 }] });
    assert.equal(ed.status, 200);
    assert.equal(ed.data.total, 80000);
    assert.equal(ed.data.owed, 70000, 'la deuda sube por la diferencia (80000 - 40000)');
    assert.equal((await art(a.id)).stock, 12);
    assert.equal((await art(b.id)).stock, 2);
    assert.equal((await art(a.id)).cost, 4500);
    const det = (await t.admin('GET', `/api/suppliers/${sup.id}`)).data;
    assert.equal(det.purchases[0].invoice, 'A-2');
    assert.equal(det.purchases[0].paid, 10000);
    assert.equal((await t.admin('GET', '/api/suppliers')).data[0].purchases_total, 80000);

    // No se puede bajar por debajo de lo ya vendido
    await t.admin('POST', '/api/sales', { items: [{ article_id: b.id, qty: 2 }], payments: [{ method: 'efectivo', amount: 60000 }] });
    const bajar = await t.admin('PUT', `/api/purchases/${c.id}`, { items: [{ article_id: a.id, qty: 12, cost: 4500 }] });
    assert.equal(bajar.status, 409);
    assert.equal((await art(b.id)).stock, 0, 'sin cambios a medias');
    assert.equal((await t.admin('POST', `/api/purchases/${c.id}/void`, {})).status, 409, 'tampoco se puede anular: el jean ya se vendió');

    // Compra aparte, sin vender nada: se anula y lo pagado queda a favor con el proveedor
    const c2 = (await t.admin('POST', '/api/purchases', { supplier_id: sup.id, items: [{ article_id: a.id, qty: 3, cost: 4500 }], paid_amount: 13500, from_cash: true })).data;
    assert.equal((await art(a.id)).stock, 15);
    const egresos = async () => (await t.admin('GET', '/api/cash/current')).data.byMethod.efectivo.egresos;
    assert.equal(await egresos(), 23500);
    const v = await t.admin('POST', `/api/purchases/${c2.id}/void`, {});
    assert.equal(v.status, 200);
    assert.equal((await art(a.id)).stock, 12);
    assert.equal(await owed(), 70000 - 13500, 'la deuda de la compra anulada desaparece y el pago queda como crédito');
    assert.equal((await t.admin('POST', `/api/purchases/${c2.id}/void`, {})).status, 409, 'ya anulada');
    assert.equal((await t.admin('PUT', `/api/purchases/${c2.id}`, { items: [{ article_id: a.id, qty: 1, cost: 1 }] })).status, 409);
    assert.equal((await t.admin('GET', '/api/suppliers')).data[0].purchases_count, 1, 'las anuladas no cuentan');

    // Otra compra anulada pidiendo que el proveedor devuelva lo pagado: vuelve a la caja
    const c3 = (await t.admin('POST', '/api/purchases', { supplier_id: sup.id, items: [{ article_id: a.id, qty: 1, cost: 5000 }], paid_amount: 5000, from_cash: true })).data;
    const antes = await owed();
    await t.admin('POST', `/api/purchases/${c3.id}/void`, { refund: true });
    assert.equal(await owed(), antes, 'queda como antes de la compra');
    assert.equal((await t.admin('GET', '/api/cash/current')).data.byMethod.efectivo.ingresos, 5000 + 60000, 'la devolución entra a la caja (más la venta)');
    assert.equal((await t.admin('GET', '/api/reports/compras')).data.rows.length, 1);

    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('POST', `/api/purchases/${c.id}/void`, {})).status, 403);
    assert.equal((await ana.call('PUT', `/api/purchases/${c.id}`, {})).status, 403);
  } finally { t.close(); }
});
