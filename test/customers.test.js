import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';

const vendedor = async (t) => {
  const roles = (await t.admin('GET', '/api/roles')).data;
  await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
  const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
  return ana;
};

test('clientes: alta, edición, búsqueda, documento único y permisos', async () => {
  const t = await start();
  try {
    assert.equal((await t.admin('POST', '/api/customers', { name: '' })).status, 400);
    const a = (await t.admin('POST', '/api/customers', { name: 'Ana Pérez', doc: '27-30111222-5', phone: '11 5555-1111' })).data;
    assert.equal(a.balance, 0);
    assert.equal((await t.admin('POST', '/api/customers', { name: 'Otra', doc: '27-30111222-5' })).status, 409, 'documento repetido');
    await t.admin('POST', '/api/customers', { name: 'Luz Gómez', phone: '11 4444-2222' });
    assert.deepEqual((await t.admin('GET', '/api/customers?q=luz')).data.map((c) => c.name), ['Luz Gómez']);
    assert.deepEqual((await t.admin('GET', '/api/customers?q=5555')).data.map((c) => c.name), ['Ana Pérez'], 'por teléfono');
    assert.equal((await t.admin('PUT', `/api/customers/${a.id}`, { name: 'Ana P.', note: 'Talle M' })).data.name, 'Ana P.');
    // Dar de baja: deja de aparecer y libera el documento
    await t.admin('PUT', `/api/customers/${a.id}`, { active: false });
    assert.equal((await t.admin('GET', '/api/customers?q=Ana')).data.length, 0);
    assert.equal((await t.admin('GET', '/api/customers?q=Ana&all=1')).data.length, 1);
    assert.equal((await t.admin('POST', '/api/customers', { name: 'Nueva Ana', doc: '27-30111222-5' })).status, 201);

    // El vendedor (rol por defecto) busca y crea; no tiene el permiso de dejar a deber
    const ana = await vendedor(t);
    assert.equal((await ana.call('GET', '/api/customers')).status, 200);
    assert.equal((await ana.call('POST', '/api/customers', { name: 'Cliente de mostrador' })).status, 201);
    const sin = (await t.admin('POST', '/api/roles', { name: 'Solo caja', permissions: ['ventas.cobrar'] })).data;
    await t.admin('POST', '/api/users', { username: 'leo', name: 'Leo', password: 'clave-leo-1234', role_id: sin.id });
    const leo = t.client(); await leo.call('POST', '/api/auth/login', { username: 'leo', password: 'clave-leo-1234' });
    assert.equal((await leo.call('POST', '/api/customers', { name: 'X' })).status, 403);
    assert.equal((await leo.call('GET', '/api/customers/1')).status, 403, 'el detalle pide clientes.ver');
  } finally { t.close(); }
});

test('cuenta corriente: seña, venta con saldo, deuda solo con permiso, anulación y devolución de saldo', async () => {
  const t = await start();
  try {
    const art = (await t.admin('POST', '/api/articles', { name: 'Vestido', price: 10000, cost: 4000, stock: 10 })).data;
    const cli = (await t.admin('POST', '/api/customers', { name: 'Ana Pérez' })).data;
    const venta = (call, body) => call('POST', '/api/sales', { items: [{ article_id: art.id, qty: 1 }], customer_id: cli.id, ...body });

    // Sin caja abierta no se puede cobrar una seña
    assert.equal((await t.admin('POST', `/api/customers/${cli.id}/payment`, { amount: 3000 })).status, 409);
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    assert.equal((await t.admin('POST', `/api/customers/${cli.id}/payment`, { amount: 0 })).status, 400);
    const sena = await t.admin('POST', `/api/customers/${cli.id}/payment`, { amount: 3000, method: 'efectivo', concept: 'Seña' });
    assert.equal(sena.data.balance, 3000);
    assert.equal((await t.admin('GET', '/api/cash/current')).data.byMethod.efectivo.neto, 3000, 'la seña entró a la caja');

    // Pagar parte con el saldo a favor y el resto en efectivo
    const v = await venta(t.admin, { account_amount: 3000, payments: [{ method: 'efectivo', amount: 7000 }] });
    assert.equal(v.status, 201);
    assert.equal((await t.admin('GET', `/api/customers/${cli.id}`)).data.balance, 0);
    assert.equal((await t.admin('GET', '/api/cash/current')).data.byMethod.efectivo.neto, 10000, 'solo entra a caja lo que se pagó en efectivo');
    const guardada = (await t.admin('GET', '/api/sales')).data.find((s) => s.id === v.data.id);
    assert.equal(guardada.customer_name, 'Ana Pérez'); assert.equal(guardada.account_amount, 3000);

    // Sin saldo no se puede usar; dejar a deber exige clientes.fiar (el vendedor por defecto no lo tiene)
    const ana = await vendedor(t);
    assert.equal((await venta(ana.call, { account_amount: 1000, payments: [{ method: 'efectivo', amount: 9000 }] })).status, 400);
    assert.equal((await venta(t.admin, { account_amount: 10000 })).status, 201, 'el administrador puede dejar a deber');
    assert.equal((await t.admin('GET', `/api/customers/${cli.id}`)).data.balance, -10000);
    assert.equal((await venta(t.admin, { account_amount: 20000 })).status, 400, 'no más que el total');
    assert.equal((await t.admin('POST', '/api/sales', { items: [{ article_id: art.id, qty: 1 }], account_amount: 5000, payments: [{ method: 'efectivo', amount: 5000 }] })).status, 400, 'sin cliente no hay cuenta');

    // Cobrar la deuda
    const pago = await t.admin('POST', `/api/customers/${cli.id}/payment`, { amount: 10000, method: 'transferencia', concept: 'Pago de deuda' });
    assert.equal(pago.data.balance, 0);

    // Anular una venta a cuenta devuelve el saldo
    const v2 = await venta(t.admin, { account_amount: 10000 });
    assert.equal((await t.admin('GET', `/api/customers/${cli.id}`)).data.balance, -10000);
    assert.equal((await t.admin('POST', `/api/sales/${v2.data.id}/void`, {})).status, 200);
    assert.equal((await t.admin('GET', `/api/customers/${cli.id}`)).data.balance, 0);

    // Devolver saldo a favor
    await t.admin('POST', `/api/customers/${cli.id}/payment`, { amount: 2000, concept: 'Seña' });
    assert.equal((await t.admin('POST', `/api/customers/${cli.id}/payout`, { amount: 5000 })).status, 400);
    assert.equal((await t.admin('POST', `/api/customers/${cli.id}/payout`, { amount: 500 })).data.balance, 1500);

    const det = (await t.admin('GET', `/api/customers/${cli.id}`)).data;
    assert.ok(det.movements.length >= 6 && det.sales.length >= 3);
    assert.equal(det.balance, det.movements.reduce((s, m) => s + m.amount, 0));
  } finally { t.close(); }
});

test('los roles creados antes de los clientes reciben los permisos nuevos una sola vez', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liuvi-mig-'));
  const file = join(dir, 'liuvi.db');
  try {
    let db = openDb(file);
    db.prepare("UPDATE roles SET permissions=? WHERE name='Vendedor'").run(JSON.stringify(['ventas.cobrar', 'stock.ver']));
    db.prepare('INSERT INTO roles (name, permissions, is_admin) VALUES (?,?,0)').run('Depósito', JSON.stringify(['stock.ver']));
    db.exec("DELETE FROM settings WHERE key='migr_clientes_v1'"); // como una base de la versión anterior
    db.close();
    db = openDb(file);
    const perms = (n) => JSON.parse(db.prepare('SELECT permissions FROM roles WHERE name=?').get(n).permissions);
    assert.deepEqual(perms('Vendedor'), ['ventas.cobrar', 'stock.ver', 'clientes.ver', 'clientes.editar', 'clientes.cuenta']);
    assert.deepEqual(perms('Depósito'), ['stock.ver'], 'quien no vende no recibe nada');
    // Si el administrador se los quita, no se vuelven a agregar al reabrir
    db.prepare("UPDATE roles SET permissions=? WHERE name='Vendedor'").run(JSON.stringify(['ventas.cobrar']));
    db.close();
    db = openDb(file);
    assert.deepEqual(perms('Vendedor'), ['ventas.cobrar']);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
