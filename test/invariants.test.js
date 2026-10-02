import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

// Operaciones al azar (con semilla fija, repetibles) sobre todo el sistema; al final se verifica que las cuentas cierren.
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

test('invariantes: con cientos de operaciones al azar, stock, caja, cuentas y compras siguen cerrando', async () => {
  const t = await start();
  const rand = rng(20261002);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  try {
    const A = [];
    for (let i = 0; i < 8; i++) A.push((await t.admin('POST', '/api/articles', { name: `Art${i}`, brand: pick(['Koxis', 'Adicta', 'Inversa']), price: int(5, 40) * 1000, cost: int(1, 4) * 1000, stock: int(0, 15), barcode: `B${i}`, size: pick(['S', 'M', 'L']) })).data);
    const C = [];
    for (let i = 0; i < 3; i++) C.push((await t.admin('POST', '/api/customers', { name: `Cli${i}` })).data);
    const S = [(await t.admin('POST', '/api/suppliers', { name: 'Prov1' })).data, (await t.admin('POST', '/api/suppliers', { name: 'Prov2' })).data];
    await t.admin('POST', '/api/cash/open', { amount: 5000 });
    for (const c of C) await t.admin('POST', `/api/customers/${c.id}/payment`, { amount: 30000, method: 'efectivo' });
    await t.admin('POST', '/api/promotions', { name: '2x1 A', kind: 'nxm', buy: 2, pay: 1, article_ids: [A[0].id, A[1].id, A[2].id] });
    await t.admin('POST', '/api/promotions', { name: '20% B', kind: 'percent', pct: 20, article_ids: [A[3].id, A[4].id] });

    const stats = {}; const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
    const call = async (label, method, path, body) => {
      const r = await t.admin(method, path, body);
      assert.ok(r.status < 500, `${label} devolvió ${r.status}: ${JSON.stringify(r.data)}`);
      bump(`${label}:${r.status < 300 ? 'ok' : 'rechazada'}`);
      return r;
    };
    const sales = [];
    for (let i = 0; i < 600; i++) {
      const op = rand();
      if (op < 0.38) {
        const items = Array.from({ length: int(1, 3) }, () => ({ article_id: pick(A).id, qty: int(1, 3) }));
        const body = { items, payments: [{ method: 'efectivo', amount: 1e7 }] };
        if (rand() < 0.3) body.discount_pct = pick([5, 10, 25]);
        if (rand() < 0.2) body.surcharge_pct = pick([3, 10]);
        if (rand() < 0.25) { body.customer_id = pick(C).id; body.account_amount = int(1, 5) * 1000; body.payments = [{ method: 'efectivo', amount: 1e7 }]; }
        const r = await call('venta', 'POST', '/api/sales', body);
        if (r.status === 201) sales.push(r.data.id);
      } else if (op < 0.5 && sales.length) {
        const id = pick(sales);
        const sale = (await t.admin('GET', '/api/sales')).data.find((s) => s.id === id) || (await t.admin('GET', '/api/sales?date=' + new Date().toLocaleDateString('sv-SE'))).data.find((s) => s.id === id);
        if (sale && !sale.voided) await call('devolucion', 'POST', '/api/returns', { sale_id: id, items: [{ sale_item_id: sale.items[0].id, qty: 1 }], leftover: pick(['efectivo', 'tarjeta']) });
      } else if (op < 0.56 && sales.length) await call('anulacion', 'POST', `/api/sales/${pick(sales)}/void`, {});
      else if (op < 0.68) {
        const r = await call('compra', 'POST', '/api/purchases', { supplier_id: pick(S).id, update_cost: rand() < 0.5, items: [{ article_id: pick(A).id, qty: int(1, 6), cost: int(1, 5) * 1000 }, { article_id: pick(A).id, qty: int(1, 3), cost: int(1, 5) * 1000 }], paid_amount: rand() < 0.5 ? int(0, 3) * 1000 : 0, from_cash: rand() < 0.5 });
        if (r.status === 201 && rand() < 0.4) await call('compra-edit', 'PUT', `/api/purchases/${r.data.id}`, { items: [{ article_id: pick(A).id, qty: int(1, 8), cost: int(1, 5) * 1000 }] });
        if (r.status === 201 && rand() < 0.3) await call('compra-anula', 'POST', `/api/purchases/${r.data.id}/void`, { refund: rand() < 0.5 });
      } else if (op < 0.72) await call('pago-prov', 'POST', `/api/suppliers/${pick(S).id}/payment`, { amount: int(1, 4) * 1000, from_cash: rand() < 0.5 });
      else if (op < 0.78) await call('ajuste', 'POST', '/api/stock/adjust', { article_id: pick(A).id, qty: int(-3, 5), reason: 'ajuste' });
      else if (op < 0.84) await call('seña', 'POST', '/api/layaways', { customer_id: pick(C).id, items: [{ article_id: pick(A).id, qty: 1 }], deposit: { amount: int(1, 3) * 1000, method: pick(['efectivo', 'cuenta']) } });
      else if (op < 0.88) {
        const open = (await t.admin('GET', '/api/layaways')).data;
        if (open.length) {
          const l = pick(open);
          if (rand() < 0.25) await call('seña-cancela', 'POST', `/api/layaways/${l.id}/cancel`, { refund: pick(['efectivo', 'credit']), leftover: pick(['efectivo', 'credit']), mode: pick(['efectivo', 'credit']) });
          else await call('seña-pago', 'POST', `/api/layaways/${l.id}/payment`, { amount: int(1, 20) * 1000, method: 'efectivo' });
        }
      } else if (op < 0.91) await call('precios', 'POST', '/api/prices/apply', { brand_id: null, mode: 'percent', value: pick([5, -5, 10]), round: 100, query: pick(['Art1', 'Art2', 'Art5']) });
      else if (op < 0.93) await call('precios-undo', 'POST', '/api/prices/undo', {});
      else if (op < 0.96) await call('cobro-cliente', 'POST', `/api/customers/${pick(C).id}/payment`, { amount: int(1, 10) * 1000, method: 'efectivo' });
      else await call('egreso-caja', 'POST', '/api/cash/movement', { type: 'egreso', method: 'efectivo', amount: int(1, 5) * 100, concept: 'gasto' });
    }
    console.log('operaciones:', JSON.stringify(stats));

    const db = t.db;
    // 1) stock = suma de sus movimientos y nunca negativo
    for (const a of db.prepare('SELECT id, name, stock FROM articles').all()) {
      const mv = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE article_id=?').get(a.id).q;
      assert.equal(a.stock, mv, `stock de ${a.name} (${a.stock}) ≠ suma de movimientos (${mv})`);
      assert.ok(a.stock >= 0, `stock negativo en ${a.name}`);
    }
    // 2) cada venta: lo cobrado (medios + cuenta + cambio) = total, y subtotal - descuento + recargo = total
    for (const s of db.prepare('SELECT * FROM sales').all()) {
      const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS a FROM sale_payments WHERE sale_id=?').get(s.id).a;
      assert.equal(r2(paid + s.account_amount + s.exchange_amount), r2(s.total), `venta #${s.id}: cobrado ${paid}+${s.account_amount} ≠ total ${s.total}`);
      assert.equal(r2(s.subtotal - s.discount + s.surcharge), r2(s.total), `venta #${s.id}: subtotal/descuento/recargo no cierran`);
      assert.ok(s.promo_discount <= s.discount + 0.005, `venta #${s.id}: oferta mayor al descuento`);
    }
    // 3) devoluciones: nunca más unidades que las vendidas
    for (const si of db.prepare('SELECT id, qty FROM sale_items').all()) {
      const back = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM return_items WHERE sale_item_id=?').get(si.id).q;
      assert.ok(back <= si.qty, `devolvió ${back} de ${si.qty}`);
    }
    // 4) deuda con cada proveedor = compras vigentes - pagos + devoluciones de pagos
    for (const s of db.prepare('SELECT id, name FROM suppliers').all()) {
      const owed = db.prepare('SELECT COALESCE(SUM(amount),0) AS b FROM supplier_movements WHERE supplier_id=?').get(s.id).b;
      const bought = db.prepare('SELECT COALESCE(SUM(total),0) AS b FROM purchases WHERE supplier_id=? AND voided=0').get(s.id).b;
      const paid = db.prepare("SELECT COALESCE(SUM(amount),0) AS b FROM supplier_movements WHERE supplier_id=? AND amount<0 AND concept LIKE 'Pago%'").get(s.id).b;
      const refunds = db.prepare("SELECT COALESCE(SUM(amount),0) AS b FROM supplier_movements WHERE supplier_id=? AND amount>0 AND concept LIKE 'Anulación: devolución%'").get(s.id).b;
      assert.equal(r2(owed), r2(bought + paid + refunds), `deuda con ${s.name}: ${owed} ≠ ${bought} + ${paid} + ${refunds}`);
    }
    // 5) apartados: nunca se cobra más que el total, y los completados tienen su venta
    for (const l of db.prepare('SELECT * FROM layaways').all()) {
      const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS a FROM layaway_payments WHERE layaway_id=?').get(l.id).a;
      if (l.status === 'open') assert.ok(paid <= l.total + 0.005, `apartado #${l.id} cobrado de más`);
      if (l.status === 'completed') assert.ok(l.sale_id, `apartado #${l.id} completado sin venta`);
    }
    // 5b) una venta anulada deja la caja como estaba (lo cobrado vuelve a salir) y devuelve el stock
    for (const s of db.prepare('SELECT * FROM sales WHERE voided=1').all()) {
      const net = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='ingreso' THEN amount ELSE -amount END),0) AS n FROM cash_movements WHERE sale_id=?").get(s.id).n;
      assert.ok(Math.abs(net) < 0.005 || s.prepaid_amount > 0, `venta anulada #${s.id}: la caja quedó con ${net}`);
    }
    // 6) la integridad de la base
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'claves foráneas rotas');
    assert.ok((stats['venta:ok'] || 0) > 50, 'el azar tiene que haber vendido varias veces');
  } finally { t.close(); }
});
