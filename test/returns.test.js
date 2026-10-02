import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

async function escenario(t) {
  const mk = async (o) => (await t.admin('POST', '/api/articles', { cost: 4000, stock: 10, ...o })).data;
  const vestido = await mk({ name: 'Vestido', brand: 'Koxis', price: 10000, barcode: 'V1' });
  const remera = await mk({ name: 'Remera', brand: 'Adicta', price: 12000, cost: 5000, barcode: 'R1' });
  const top = await mk({ name: 'Top', brand: 'Inversa', price: 7000, cost: 2500, barcode: 'T1' });
  await t.admin('POST', '/api/cash/open', { amount: 0 });
  return { vestido, remera, top };
}
const stock = async (t, id) => (await t.admin('GET', '/api/articles?all=1')).data.find((a) => a.id === id).stock;
const efectivo = async (t) => (await t.admin('GET', '/api/cash/current')).data.byMethod.efectivo.neto;
const sale = async (t, body) => (await t.admin('POST', '/api/sales', body)).data;
const detail = async (t, id) => (await t.admin('GET', '/api/sales')).data.find((s) => s.id === id);

test('devolución: vuelve al stock, devuelve el dinero con el descuento prorrateado y respeta los límites', async () => {
  const t = await start();
  try {
    const { vestido } = await escenario(t);
    // 2 vestidos con 10 % de descuento: total 18000, cada uno se pagó 9000
    const v = await sale(t, { items: [{ article_id: vestido.id, qty: 2 }], discount_pct: 10, payments: [{ method: 'efectivo', amount: 18000 }] });
    assert.equal(await stock(t, vestido.id), 8);
    const item = (await detail(t, v.id)).items[0];

    const r = await t.admin('POST', '/api/returns', { sale_id: v.id, items: [{ sale_item_id: item.id, qty: 1 }], leftover: 'efectivo' });
    assert.equal(r.status, 201);
    assert.equal(r.data.value, 9000);
    assert.equal(r.data.refund_cash, 9000);
    assert.equal(r.data.kind, 'devolucion');
    assert.equal(await stock(t, vestido.id), 9);
    assert.equal(await efectivo(t), 18000 - 9000);
    assert.equal((await detail(t, v.id)).items[0].returned, 1);
    assert.equal((await detail(t, v.id)).returned_value, 9000);

    // No se puede devolver más de lo vendido
    const mucho = await t.admin('POST', '/api/returns', { sale_id: v.id, items: [{ sale_item_id: item.id, qty: 2 }], leftover: 'efectivo' });
    assert.equal(mucho.status, 409); assert.match(mucho.data.error, /solo se pueden devolver 1/);
    assert.equal((await t.admin('POST', '/api/returns', { sale_id: v.id, items: [{ sale_item_id: item.id, qty: 1 }], leftover: 'efectivo' })).status, 201);
    assert.equal((await t.admin('POST', '/api/returns', { sale_id: v.id, items: [{ sale_item_id: item.id, qty: 1 }], leftover: 'efectivo' })).status, 409);
    assert.equal(await efectivo(t), 0, 'se devolvió todo lo cobrado, ni un peso más');

    // Validaciones
    assert.equal((await t.admin('POST', '/api/returns', { sale_id: v.id, items: [] })).status, 400);
    assert.equal((await t.admin('POST', '/api/returns', { sale_id: 999, items: [{ sale_item_id: 1, qty: 1 }], leftover: 'efectivo' })).status, 404);
    const otra = await sale(t, { items: [{ article_id: vestido.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 10000 }] });
    assert.equal((await t.admin('POST', '/api/returns', { sale_id: otra.id, items: [{ sale_item_id: item.id, qty: 1 }], leftover: 'efectivo' })).status, 400, 'la prenda es de otra venta');
    assert.equal((await t.admin('POST', '/api/returns', { sale_id: otra.id, items: [{ sale_item_id: (await detail(t, otra.id)).items[0].id, qty: 1 }] })).status, 400, 'falta indicar cómo se devuelve el dinero');
    assert.equal(await stock(t, vestido.id), 9, 'lo que falló no tocó el stock');
    assert.equal((await t.admin('GET', '/api/returns')).data.length, 2);
  } finally { t.close(); }
});

test('devolución con saldo a favor del cliente', async () => {
  const t = await start();
  try {
    const { vestido } = await escenario(t);
    const v = await sale(t, { items: [{ article_id: vestido.id, qty: 1 }], payments: [{ method: 'tarjeta', amount: 10000 }] });
    const itemId = (await detail(t, v.id)).items[0].id;
    const body = { sale_id: v.id, items: [{ sale_item_id: itemId, qty: 1 }], leftover: 'credit' };
    assert.equal((await t.admin('POST', '/api/returns', body)).status, 400, 'sin cliente no hay dónde dejar el saldo');
    const cli = (await t.admin('POST', '/api/customers', { name: 'Ana Pérez' })).data;
    const r = await t.admin('POST', '/api/returns', { ...body, customer_id: cli.id });
    assert.equal(r.status, 201); assert.equal(r.data.credit_amount, 10000);
    assert.equal((await t.admin('GET', `/api/customers/${cli.id}`)).data.balance, 10000);
    assert.equal((await t.admin('GET', '/api/cash/current')).data.byMethod.tarjeta.neto, 10000, 'no salió plata de la caja');
  } finally { t.close(); }
});

test('cambio: lo devuelto cubre la prenda nueva; diferencia a pagar o a devolver', async () => {
  const t = await start();
  try {
    const { vestido, remera, top } = await escenario(t);
    const mkVenta = async () => { const v = await sale(t, { items: [{ article_id: vestido.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 10000 }] }); return { id: v.id, item: (await detail(t, v.id)).items[0].id }; };

    // Cambia el vestido (10000) por una remera (12000): paga 2000
    const a = await mkVenta();
    const falta = await t.admin('POST', '/api/returns', { sale_id: a.id, items: [{ sale_item_id: a.item, qty: 1 }], new_items: [{ article_id: remera.id, qty: 1 }] });
    assert.equal(falta.status, 400, 'falta cobrar la diferencia');
    assert.equal(await stock(t, vestido.id), 9, 'el rechazo lo deshizo todo (el vestido no volvió al stock)');
    assert.equal((await t.admin('GET', '/api/returns')).data.length, 0);
    const caja0 = await efectivo(t);
    const c1 = await t.admin('POST', '/api/returns', { sale_id: a.id, items: [{ sale_item_id: a.item, qty: 1 }], new_items: [{ article_id: remera.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 2000 }] });
    assert.equal(c1.status, 201);
    assert.equal(c1.data.kind, 'cambio'); assert.equal(c1.data.exchange_amount, 10000); assert.equal(c1.data.refund_cash, 0);
    assert.equal(c1.data.new_sale.total, 12000); assert.equal(c1.data.new_sale.exchange_amount, 10000);
    assert.equal(await stock(t, vestido.id), 10); assert.equal(await stock(t, remera.id), 9);
    assert.equal(await efectivo(t), caja0 + 2000, 'solo entra la diferencia');

    // Devolver después la remera del cambio: solo se devuelve lo que se pagó de verdad (2000), no lo cubierto con el vestido
    const rem = (await detail(t, c1.data.new_sale_id)).items[0];
    const c1b = await t.admin('POST', '/api/returns', { sale_id: c1.data.new_sale_id, items: [{ sale_item_id: rem.id, qty: 1 }], leftover: 'efectivo' });
    assert.equal(c1b.status, 201); assert.equal(c1b.data.value, 2000);

    // Cambia el vestido (10000) por un top (7000): se le devuelven 3000 (o quedan a favor)
    const b = await mkVenta();
    const base = { sale_id: b.id, items: [{ sale_item_id: b.item, qty: 1 }], new_items: [{ article_id: top.id, qty: 1 }] };
    assert.equal((await t.admin('POST', '/api/returns', base)).status, 400, 'falta indicar cómo se devuelve la diferencia');
    const c2 = await t.admin('POST', '/api/returns', { ...base, leftover: 'efectivo' });
    assert.equal(c2.status, 201); assert.equal(c2.data.refund_cash, 3000); assert.equal(c2.data.exchange_amount, 7000);

    // La venta original de un cambio no se puede anular, ni la que tiene devoluciones
    assert.equal((await t.admin('POST', `/api/sales/${b.id}/void`, {})).status, 409);
    assert.equal((await t.admin('POST', `/api/sales/${c2.data.new_sale_id}/void`, {})).status, 409);

    // Pagar la diferencia con saldo a favor del cliente
    const cli = (await t.admin('POST', '/api/customers', { name: 'Luz' })).data;
    await t.admin('POST', `/api/customers/${cli.id}/payment`, { amount: 5000, concept: 'Seña' });
    const d = await mkVenta();
    const c3 = await t.admin('POST', '/api/returns', { sale_id: d.id, items: [{ sale_item_id: d.item, qty: 1 }], new_items: [{ article_id: remera.id, qty: 1 }], customer_id: cli.id, account_amount: 2000 });
    assert.equal(c3.status, 201);
    assert.equal((await t.admin('GET', `/api/customers/${cli.id}`)).data.balance, 3000);
  } finally { t.close(); }
});

test('estadísticas y caja descuentan lo devuelto', async () => {
  const t = await start();
  try {
    const { vestido, remera } = await escenario(t);
    const v = await sale(t, { items: [{ article_id: vestido.id, qty: 2 }], payments: [{ method: 'efectivo', amount: 20000 }] });
    const item = (await detail(t, v.id)).items[0].id;
    await t.admin('POST', '/api/returns', { sale_id: v.id, items: [{ sale_item_id: item, qty: 1 }], new_items: [{ article_id: remera.id, qty: 1 }], payments: [{ method: 'tarjeta', amount: 2000 }] });
    // Ventas: 20000 + 12000; devuelto 10000 => neto 22000
    const hoy = (await t.admin('GET', '/api/stats/series?group=day')).data.at(-1);
    assert.equal(hoy.total, 22000);
    assert.equal(hoy.units, 2, '3 unidades vendidas menos 1 devuelta');
    assert.equal(hoy.profit, 22000 - (4000 * 1 + 5000 * 1), 'ganancia con el costo de lo que se quedó');
    const br = (await t.admin('GET', '/api/stats/breakdown?group=day')).data;
    assert.equal(br.total, 22000);
    assert.equal(br.byBrand.find((b) => b.brand === 'Koxis').total, 10000);
    assert.deepEqual(br.topArticles.map((a) => [a.name, a.units]).sort(), [['Adicta · Remera', 1], ['Koxis · Vestido', 1]]);
    const caja = (await t.admin('GET', '/api/cash/current')).data;
    assert.equal(caja.sales_total, 22000);
    assert.equal(caja.byMethod.efectivo.neto, 20000); assert.equal(caja.byMethod.tarjeta.neto, 2000);
  } finally { t.close(); }
});

test('permiso para cambios y devoluciones, y caja abierta', async () => {
  const t = await start();
  try {
    const { vestido } = await escenario(t);
    const v = await sale(t, { items: [{ article_id: vestido.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 10000 }] });
    const item = (await detail(t, v.id)).items[0].id;
    const body = { sale_id: v.id, items: [{ sale_item_id: item, qty: 1 }], leftover: 'efectivo' };
    const roles = (await t.admin('GET', '/api/roles')).data;
    const sin = (await t.admin('POST', '/api/roles', { name: 'Solo cobra', permissions: ['ventas.cobrar'] })).data;
    await t.admin('POST', '/api/users', { username: 'leo', name: 'Leo', password: 'clave-leo-1234', role_id: sin.id });
    const leo = t.client(); await leo.call('POST', '/api/auth/login', { username: 'leo', password: 'clave-leo-1234' });
    assert.equal((await leo.call('POST', '/api/returns', body)).status, 403);
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    await t.admin('POST', '/api/cash/close', { counted: 10000 });
    assert.equal((await ana.call('POST', '/api/returns', body)).status, 409, 'con la caja cerrada no se puede devolver dinero');
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    assert.equal((await ana.call('POST', '/api/returns', body)).status, 201, 'el vendedor por defecto puede');
  } finally { t.close(); }
});
