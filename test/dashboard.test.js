import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('panel de inicio: ventas del día netas de devoluciones, stock bajo, deudas y permisos', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { name: 'Remera', price: 1000, cost: 400, stock: 5, min_stock: 2 })).data;
    await t.admin('POST', '/api/articles', { name: 'Jean', price: 3000, cost: 1000, stock: 1, min_stock: 2 });
    await t.admin('POST', '/api/cash/open', { amount: 100 });
    let d = (await t.admin('GET', '/api/dashboard')).data;
    assert.equal(d.today.total, 0);
    assert.equal(d.cash.open, true);
    assert.equal(d.lowStock.count, 1, 'solo el jean está en o bajo el mínimo');

    const sale = (await t.admin('POST', '/api/sales', { items: [{ article_id: a.id, qty: 2 }], payments: [{ method: 'efectivo', amount: 2000 }] })).data;
    d = (await t.admin('GET', '/api/dashboard')).data;
    assert.equal(d.today.total, 2000);
    assert.equal(d.today.sales, 1);
    assert.equal(d.today.profit, 1200);
    assert.equal(d.cash.expected_cash, 2100);
    assert.equal(d.week.length, 7);
    assert.equal(d.top[0].units, 2);
    assert.ok(d.layaways && d.debts && d.backup, 'el administrador ve todos los bloques');
    assert.ok(sale.id);

    // Un usuario con solo caja.ver ve el día pero no estadísticas, costos ni clientes
    const role = (await t.admin('POST', '/api/roles', { name: 'Caja', permissions: ['caja.ver'] })).data;
    await t.admin('POST', '/api/users', { username: 'caja', name: 'Caja', password: 'clave-caja-123', role_id: role.id });
    const c = t.client(); await c.call('POST', '/api/auth/login', { username: 'caja', password: 'clave-caja-123' });
    const r = (await c.call('GET', '/api/dashboard')).data;
    assert.equal(r.today.total, 2000);
    assert.equal(r.today.profit, null);
    assert.equal(r.week, undefined);
    assert.equal(r.debts, undefined);
    assert.equal(r.backup, undefined);

    // Sin permisos de panel: 403
    const v = t.client(); const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((x) => x.name === 'Vendedor').id });
    await v.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await v.call('GET', '/api/dashboard')).status, 403);
  } finally { t.close(); }
});
