import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

async function escenario(t) {
  const mk = async (o) => (await t.admin('POST', '/api/articles', { cost: 4000, stock: 3, ...o })).data;
  const vestido = await mk({ name: 'Vestido', brand: 'Koxis', price: 10000, barcode: 'V1' });
  const top = await mk({ name: 'Top', brand: 'Inversa', price: 7000, cost: 2500, barcode: 'T1', stock: 5 });
  const cli = (await t.admin('POST', '/api/customers', { name: 'Ana Pérez', doc: '27-30111222-5' })).data;
  await t.admin('POST', '/api/cash/open', { amount: 0 });
  return { vestido, top, cli };
}
const art = async (t, id) => (await t.admin('GET', '/api/articles?all=1')).data.find((a) => a.id === id);
const caja = async (t) => (await t.admin('GET', '/api/cash/current')).data.byMethod;
const balance = async (t, id) => (await t.admin('GET', `/api/customers/${id}`)).data.balance;

test('apartado: reserva la mercadería, fija el precio y al completar el pago se descuenta del stock', async () => {
  const t = await start();
  try {
    const { vestido, top, cli } = await escenario(t);
    const body = { customer_id: cli.id, items: [{ article_id: vestido.id, qty: 2 }, { article_id: top.id, qty: 1 }], deposit: { amount: 5000, method: 'efectivo' } };
    assert.equal((await t.admin('POST', '/api/layaways', { ...body, customer_id: undefined })).status, 400, 'hace falta el cliente');
    assert.equal((await t.admin('POST', '/api/layaways', { ...body, deposit: { amount: 0 } })).status, 400, 'hace falta una seña');
    assert.equal((await t.admin('POST', '/api/layaways', { ...body, deposit: { amount: 99999 } })).status, 400, 'la seña no puede superar el total');
    assert.equal((await t.admin('POST', '/api/layaways', { ...body, items: [{ article_id: vestido.id, qty: 4 }] })).status, 409, 'no hay tanto stock');

    const l = await t.admin('POST', '/api/layaways', body);
    assert.equal(l.status, 201);
    assert.equal(l.data.total, 27000); assert.equal(l.data.paid, 5000); assert.equal(l.data.remaining, 22000); assert.equal(l.data.status, 'open');
    assert.equal((await caja(t)).efectivo.neto, 5000, 'la seña entró a la caja');
    // Queda separado: el stock físico sigue, pero 2 vestidos no se pueden vender a otro
    const v = await art(t, vestido.id);
    assert.equal(v.stock, 3); assert.equal(v.reserved, 2);
    const otro = (client) => client('POST', '/api/sales', { items: [{ article_id: vestido.id, qty: 2 }], payments: [{ method: 'efectivo', amount: 20000 }] });
    const rechazo = await otro(t.admin);
    assert.equal(rechazo.status, 409); assert.match(rechazo.data.error, /apartado/);
    assert.equal((await t.admin('POST', '/api/sales', { items: [{ article_id: vestido.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 10000 }] })).status, 201, 'el vestido libre sí se vende');
    // Aunque suba el precio, el apartado conserva el de ese día
    await t.admin('PUT', `/api/articles/${vestido.id}`, { name: 'Vestido', price: 15000 });

    // Pagos parciales
    assert.equal((await t.admin('POST', `/api/layaways/${l.data.id}/payment`, { amount: 99999, method: 'efectivo' })).status, 400, 'no se cobra de más');
    const p2 = await t.admin('POST', `/api/layaways/${l.data.id}/payment`, { amount: 12000, method: 'tarjeta' });
    assert.equal(p2.data.remaining, 10000); assert.equal(p2.data.sale, null); assert.equal(p2.data.status, 'open');
    assert.equal((await art(t, top.id)).stock, 5, 'todavía no sale del stock');

    // El último pago completa: se entrega y se descuenta del stock
    const p3 = await t.admin('POST', `/api/layaways/${l.data.id}/payment`, { amount: 10000, method: 'efectivo' });
    assert.equal(p3.status, 201); assert.equal(p3.data.status, 'completed'); assert.equal(p3.data.remaining, 0);
    const sale = p3.data.sale;
    assert.equal(sale.total, 27000, 'a los precios del día de la seña');
    assert.equal(sale.prepaid_amount, 27000);
    assert.equal((await art(t, vestido.id)).stock, 0, '3 − 1 vendido − 2 entregados'); assert.equal((await art(t, vestido.id)).reserved, 0);
    assert.equal((await art(t, top.id)).stock, 4);
    // La cuenta corriente queda limpia, y la caja no cuenta dos veces la plata
    assert.equal(await balance(t, cli.id), 0);
    const c = await caja(t);
    assert.equal(c.efectivo.neto, 5000 + 10000 + 10000); assert.equal(c.tarjeta.neto, 12000);
    const guardada = (await t.admin('GET', '/api/sales')).data.find((s) => s.id === sale.id);
    assert.equal(guardada.customer_name, 'Ana Pérez');
    assert.deepEqual(guardada.payments.map((p) => [p.method, p.amount]).sort(), [['efectivo', 15000], ['tarjeta', 12000]]);
    assert.equal(guardada.prepaid_amount, 27000);
    // Ventas netas: sumó 27000 + el vestido vendido aparte (10000)
    assert.equal((await t.admin('GET', '/api/stats/series?group=day')).data.at(-1).total, 37000);
    // No se puede pagar un apartado cerrado
    assert.equal((await t.admin('POST', `/api/layaways/${l.data.id}/payment`, { amount: 1, method: 'efectivo' })).status, 409);
    // Anular esa venta devuelve toda la plata cobrada (señas incluidas)
    assert.equal((await t.admin('POST', `/api/sales/${sale.id}/void`, {})).status, 200);
    assert.equal((await caja(t)).tarjeta.neto, 0);
  } finally { t.close(); }
});

test('apartado pagado de una vez, con saldo a favor, y cancelación (devolver o dejar saldo)', async () => {
  const t = await start();
  try {
    const { vestido, top, cli } = await escenario(t);
    // Paga todo junto: se entrega en el acto
    const todo = await t.admin('POST', '/api/layaways', { customer_id: cli.id, items: [{ article_id: top.id, qty: 1 }], deposit: { amount: 7000, method: 'transferencia' } });
    assert.equal(todo.data.status, 'completed'); assert.ok(todo.data.sale);
    assert.equal((await art(t, top.id)).stock, 4);

    // Saldo a favor como seña
    await t.admin('POST', `/api/customers/${cli.id}/payment`, { amount: 4000, concept: 'Seña' });
    const sinSaldo = await t.admin('POST', '/api/layaways', { customer_id: cli.id, items: [{ article_id: vestido.id, qty: 1 }], deposit: { amount: 5000, method: 'cuenta' } });
    assert.equal(sinSaldo.status, 400, 'no tiene tanto saldo');
    const l = (await t.admin('POST', '/api/layaways', { customer_id: cli.id, items: [{ article_id: vestido.id, qty: 1 }], deposit: { amount: 4000, method: 'cuenta' } })).data;
    assert.equal(await balance(t, cli.id), 0);
    const efectivo0 = (await caja(t)).efectivo.neto;
    // Pago en efectivo y completa: queda la cuenta en cero y se entrega
    const fin = (await t.admin('POST', `/api/layaways/${l.id}/payment`, { amount: 6000, method: 'efectivo' })).data;
    assert.equal(fin.status, 'completed'); assert.equal(await balance(t, cli.id), 0);
    assert.equal((await caja(t)).efectivo.neto, efectivo0 + 6000);

    // Cancelación: devolver la seña en efectivo
    const a = (await t.admin('POST', '/api/layaways', { customer_id: cli.id, items: [{ article_id: vestido.id, qty: 1 }], deposit: { amount: 3000, method: 'efectivo' } })).data;
    assert.equal((await art(t, vestido.id)).reserved, 1);
    assert.equal((await t.admin('POST', `/api/layaways/${a.id}/cancel`, {})).status, 400, 'hay que decir qué pasa con la seña');
    const antes = (await caja(t)).efectivo.neto;
    assert.equal((await t.admin('POST', `/api/layaways/${a.id}/cancel`, { refund: 'efectivo' })).data.status, 'cancelled');
    assert.equal((await caja(t)).efectivo.neto, antes - 3000);
    assert.equal((await art(t, vestido.id)).reserved, 0, 'la mercadería se libera');
    assert.equal((await t.admin('POST', `/api/layaways/${a.id}/cancel`, { refund: 'efectivo' })).status, 409);

    // Cancelación: dejar la seña como saldo a favor
    const b = (await t.admin('POST', '/api/layaways', { customer_id: cli.id, items: [{ article_id: vestido.id, qty: 1 }], deposit: { amount: 2500, method: 'tarjeta' } })).data;
    const antes2 = (await caja(t)).tarjeta.neto;
    await t.admin('POST', `/api/layaways/${b.id}/cancel`, { refund: 'credit' });
    assert.equal(await balance(t, cli.id), 2500);
    assert.equal((await caja(t)).tarjeta.neto, antes2, 'no sale plata de la caja');
    assert.equal((await t.admin('GET', '/api/layaways?status=all')).data.length, 4);
    assert.equal((await t.admin('GET', '/api/layaways')).data.length, 0, 'por defecto solo los abiertos');
  } finally { t.close(); }
});

test('apartados: permisos y límites con stock', async () => {
  const t = await start();
  try {
    const { vestido, cli } = await escenario(t);
    const l = (await t.admin('POST', '/api/layaways', { customer_id: cli.id, items: [{ article_id: vestido.id, qty: 1 }], deposit: { amount: 1000, method: 'efectivo' } })).data;
    // Limpiar el stock no es posible con mercadería apartada
    const lim = await t.admin('POST', '/api/stock/clear', { mode: 'zero', confirm: 'LIMPIAR' });
    assert.equal(lim.status, 409); assert.match(lim.data.error, /apartados/);
    const roles = (await t.admin('GET', '/api/roles')).data;
    const sin = (await t.admin('POST', '/api/roles', { name: 'Solo cobra', permissions: ['ventas.cobrar'] })).data;
    await t.admin('POST', '/api/users', { username: 'leo', name: 'Leo', password: 'clave-leo-1234', role_id: sin.id });
    const leo = t.client(); await leo.call('POST', '/api/auth/login', { username: 'leo', password: 'clave-leo-1234' });
    assert.equal((await leo.call('POST', `/api/layaways/${l.id}/payment`, { amount: 100, method: 'efectivo' })).status, 201, 'cobrar una cuota es de quien cobra');
    assert.equal((await leo.call('POST', `/api/layaways/${l.id}/cancel`, { refund: 'efectivo' })).status, 403, 'cancelar y devolver plata pide el permiso de devoluciones');
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('POST', `/api/layaways/${l.id}/cancel`, { refund: 'efectivo' })).status, 200, 'el vendedor por defecto sí');
    // Sin caja abierta no se puede señar
    await t.admin('POST', '/api/cash/close', { counted: 0 });
    assert.equal((await t.admin('POST', '/api/layaways', { customer_id: cli.id, items: [{ article_id: vestido.id, qty: 1 }], deposit: { amount: 1000, method: 'efectivo' } })).status, 409);
  } finally { t.close(); }
});
