// Reportes para ver, imprimir (PDF) o bajar a Excel. Cada reporte devuelve la misma estructura:
// { title, subtitle, columns: [{ label, type: 'text' | 'money' | 'int' }], rows: [[...]], totals: [...] | null }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const REPORTS = [
  { kind: 'ventas', label: 'Ventas (detalle)', range: true, perm: ['estadisticas.ver'] },
  { kind: 'articulos', label: 'Ventas por artículo', range: true, perm: ['estadisticas.ver'] },
  { kind: 'marcas', label: 'Ventas por marca', range: true, perm: ['estadisticas.ver'] },
  { kind: 'vendedores', label: 'Ventas por vendedor', range: true, perm: ['estadisticas.ver'] },
  { kind: 'caja', label: 'Cajas (aperturas y cierres)', range: true, perm: ['caja.ver'] },
  { kind: 'compras', label: 'Compras a proveedores', range: true, perm: ['proveedores.ver'] },
  { kind: 'proveedores', label: 'Deudas con proveedores', range: false, perm: ['proveedores.ver'] },
  { kind: 'stock', label: 'Stock valorizado', range: false, perm: ['stock.ver'] },
  { kind: 'clientes', label: 'Cuentas corrientes de clientes', range: false, perm: ['clientes.ver'] },
];

export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(new Date(s + 'T12:00:00').getTime());
const fmtDay = (d) => d.split('-').reverse().join('/');
const sum = (rows, i) => round2(rows.reduce((a, r) => a + (Number(r[i]) || 0), 0));

export function buildReport(db, kind, { from, to }, can) {
  const def = REPORTS.find((r) => r.kind === kind);
  if (!def) return null;
  const sub = def.range ? (from === to ? fmtDay(from) : `del ${fmtDay(from)} al ${fmtDay(to)}`) : `al ${fmtDay(new Date().toLocaleDateString('sv-SE'))}`;
  const rep = { kind, title: def.label, subtitle: sub, columns: [], rows: [], totals: null };
  const costs = can('costos.ver');
  const inSales = "s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?";

  if (kind === 'ventas') {
    rep.columns = [['N°', 'int'], ['Fecha', 'text'], ['Hora', 'text'], ['Vendedor', 'text'], ['Cliente', 'text'],
      ['Efectivo', 'money'], ['Tarjeta', 'money'], ['Transferencia', 'money'], ['Cuenta corriente', 'money'], ['Seña / cambio', 'money'],
      ['Descuento', 'money'], ['Recargo', 'money'], ['Total', 'money'], ['Devuelto', 'money'], ['Estado', 'text']];
    const sales = db.prepare(`SELECT s.*, COALESCE(u.name,'') AS seller,
        COALESCE((SELECT SUM(value) FROM returns WHERE sale_id = s.id),0) AS returned
      FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE date(s.created_at) BETWEEN ? AND ? ORDER BY s.id`).all(from, to);
    const pay = db.prepare('SELECT method, SUM(amount) AS a FROM sale_payments WHERE sale_id=? GROUP BY method');
    rep.rows = sales.map((s) => {
      const m = Object.fromEntries(pay.all(s.id).map((p) => [p.method, p.a]));
      return [s.id, s.created_at.slice(0, 10), s.created_at.slice(11, 16), s.seller, s.customer_name || '',
        m.efectivo || 0, m.tarjeta || 0, m.transferencia || 0, s.account_amount || 0, round2((s.prepaid_amount || 0) + (s.exchange_amount || 0)),
        s.discount || 0, s.surcharge || 0, s.total, s.returned, s.voided ? 'Anulada' : 'OK'];
    });
    const ok = rep.rows.filter((r) => r[14] === 'OK');
    rep.totals = ['', '', '', '', `Total (${ok.length} venta${ok.length === 1 ? "" : "s"}, sin anuladas)`, ...[5, 6, 7, 8, 9, 10, 11, 12, 13].map((i) => sum(ok, i)), ''];
  } else if (kind === 'articulos' || kind === 'marcas') {
    const byBrand = kind === 'marcas';
    const key = byBrand ? "COALESCE(i.brand,'Sin marca')" : 'i.article_id';
    const rows = db.prepare(`
      SELECT ${byBrand ? "COALESCE(i.brand,'Sin marca') AS name, '' AS brand" : "i.name AS name, COALESCE(i.brand,'') AS brand"},
             SUM(i.qty - COALESCE((SELECT SUM(qty) FROM return_items WHERE sale_item_id = i.id),0)) AS units,
             SUM((i.qty - COALESCE((SELECT SUM(qty) FROM return_items WHERE sale_item_id = i.id),0)) * i.price) AS total,
             SUM((i.qty - COALESCE((SELECT SUM(qty) FROM return_items WHERE sale_item_id = i.id),0)) * i.cost) AS cost
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${inSales} GROUP BY ${key} ORDER BY total DESC`).all(from, to).filter((r) => r.units > 0);
    rep.columns = byBrand ? [['Marca', 'text']] : [['Artículo', 'text'], ['Marca', 'text']];
    rep.columns.push(['Unidades', 'int'], ['Vendido (precio de lista)', 'money']);
    if (costs) rep.columns.push(['Costo', 'money'], ['Ganancia', 'money']);
    rep.rows = rows.map((r) => [...(byBrand ? [r.name] : [r.name, r.brand]), r.units, round2(r.total), ...(costs ? [round2(r.cost), round2(r.total - r.cost)] : [])]);
    const n = byBrand ? 1 : 2;
    rep.totals = [...(byBrand ? ['Total'] : ['Total', '']), ...Array.from({ length: rep.columns.length - n }, (_, k) => sum(rep.rows, n + k))];
  } else if (kind === 'vendedores') {
    rep.columns = [['Vendedor', 'text'], ['Ventas', 'int'], ['Total vendido', 'money'], ['Devuelto', 'money'], ['Neto', 'money']];
    const rows = db.prepare(`
      SELECT COALESCE(u.name,'Sin usuario') AS seller, COUNT(*) AS n, SUM(s.total) AS total,
             COALESCE(SUM((SELECT SUM(value) FROM returns WHERE sale_id = s.id)),0) AS returned
      FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE ${inSales} GROUP BY s.user_id ORDER BY total DESC`).all(from, to);
    rep.rows = rows.map((r) => [r.seller, r.n, round2(r.total), round2(r.returned), round2(r.total - r.returned)]);
    rep.totals = ['Total', sum(rep.rows, 1), sum(rep.rows, 2), sum(rep.rows, 3), sum(rep.rows, 4)];
  } else if (kind === 'caja') {
    rep.columns = [['Caja N°', 'int'], ['Apertura', 'text'], ['Cierre', 'text'], ['Monto inicial', 'money'], ['Efectivo', 'money'], ['Tarjeta', 'money'], ['Transferencia', 'money'], ['Efectivo esperado', 'money'], ['Efectivo contado', 'money'], ['Diferencia', 'money'], ['Nota', 'text']];
    const sessions = db.prepare('SELECT * FROM cash_sessions WHERE date(opened_at) BETWEEN ? AND ? ORDER BY id').all(from, to);
    const mv = db.prepare("SELECT method, SUM(CASE WHEN type='ingreso' THEN amount ELSE -amount END) AS net FROM cash_movements WHERE session_id=? GROUP BY method");
    rep.rows = sessions.map((s) => {
      const m = Object.fromEntries(mv.all(s.id).map((x) => [x.method, round2(x.net)]));
      const cash = m.efectivo || 0, closed = s.closed_at != null;
      return [s.id, s.opened_at.slice(0, 16), closed ? s.closed_at.slice(0, 16) : 'Abierta', s.opening_amount, cash, m.tarjeta || 0, m.transferencia || 0,
        closed ? s.expected_cash : round2(s.opening_amount + cash), closed ? s.counted_cash : '', closed ? round2(s.counted_cash - s.expected_cash) : '', s.note || ''];
    });
    rep.totals = ['Total', '', '', sum(rep.rows, 3), sum(rep.rows, 4), sum(rep.rows, 5), sum(rep.rows, 6), '', '', sum(rep.rows, 9), ''];
  } else if (kind === 'compras') {
    rep.columns = [['N°', 'int'], ['Fecha', 'text'], ['Proveedor', 'text'], ['Factura / remito', 'text'], ['Unidades', 'int'], ['Total', 'money']];
    rep.rows = db.prepare(`SELECT p.id, p.bought_at, s.name, p.invoice, COALESCE((SELECT SUM(qty) FROM purchase_items WHERE purchase_id=p.id),0) AS units, p.total
      FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.bought_at BETWEEN ? AND ? ORDER BY p.id`).all(from, to).map((r) => [r.id, r.bought_at, r.name, r.invoice, r.units, r.total]);
    rep.totals = ['', '', `Total (${rep.rows.length})`, '', sum(rep.rows, 4), sum(rep.rows, 5)];
  } else if (kind === 'proveedores') {
    rep.columns = [['Proveedor', 'text'], ['Teléfono', 'text'], ['Compras', 'int'], ['Total comprado', 'money'], ['Se le debe', 'money'], ['Última compra', 'text']];
    rep.rows = db.prepare(`SELECT s.name, s.phone, (SELECT COUNT(*) FROM purchases WHERE supplier_id=s.id) AS n, COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id=s.id),0) AS bought,
        COALESCE((SELECT SUM(amount) FROM supplier_movements WHERE supplier_id=s.id),0) AS owed, COALESCE((SELECT MAX(bought_at) FROM purchases WHERE supplier_id=s.id),'') AS last
      FROM suppliers s WHERE s.active = 1 ORDER BY owed DESC, s.name COLLATE NOCASE`).all().map((r) => [r.name, r.phone, r.n, round2(r.bought), round2(r.owed), r.last]);
    rep.totals = ['Total', '', sum(rep.rows, 2), sum(rep.rows, 3), sum(rep.rows, 4), ''];
  } else if (kind === 'stock') {
    rep.columns = [['Artículo', 'text'], ['Marca', 'text'], ['Talle', 'text'], ['Color', 'text'], ['Código', 'text'], ['Stock', 'int'], ['Precio', 'money']];
    if (costs) rep.columns.push(['Costo', 'money'], ['Valor a costo', 'money']);
    rep.columns.push(['Valor a precio', 'money']);
    const rows = db.prepare(`SELECT a.name, COALESCE(b.name,'') AS brand, a.size, a.color, COALESCE(a.barcode,'') AS barcode, a.stock, a.price, a.cost
      FROM articles a LEFT JOIN brands b ON b.id = a.brand_id WHERE a.active = 1 ORDER BY b.name, a.name, a.size`).all();
    rep.rows = rows.map((r) => [r.name, r.brand, r.size, r.color, r.barcode, r.stock, r.price, ...(costs ? [r.cost, round2(r.stock * r.cost)] : []), round2(r.stock * r.price)]);
    const nCols = rep.columns.length;
    rep.totals = ['Total', '', '', '', '', sum(rep.rows, 5), '', ...(costs ? ['', sum(rep.rows, 8)] : []), sum(rep.rows, nCols - 1)];
  } else if (kind === 'clientes') {
    rep.columns = [['Cliente', 'text'], ['Documento', 'text'], ['Teléfono', 'text'], ['Saldo (negativo = debe)', 'money'], ['Última compra', 'text']];
    const rows = db.prepare(`SELECT c.name, c.doc, c.phone, COALESCE((SELECT SUM(amount) FROM account_movements WHERE customer_id=c.id),0) AS balance,
        COALESCE((SELECT MAX(created_at) FROM sales WHERE customer_id=c.id AND voided=0),'') AS last_sale
      FROM customers c WHERE c.active = 1 ORDER BY balance, c.name COLLATE NOCASE`).all().filter((r) => Math.abs(r.balance) > 0.004);
    rep.rows = rows.map((r) => [r.name, r.doc, r.phone, round2(r.balance), r.last_sale.slice(0, 10)]);
    rep.totals = ['Total', '', '', sum(rep.rows, 3), ''];
  }
  rep.columns = rep.columns.map(([label, type]) => ({ label, type }));
  return rep;
}

// Hoja de Excel (para buildXlsx): título, período, encabezados, datos y total. Estilos: 6 = importe, 7 = importe en negrita.
export function reportSheet(rep) {
  const num = (type, v, bold) => (type === 'money' && v !== '' && v !== null ? { v: Number(v), s: bold ? 7 : 6 } : type === 'int' && v !== '' ? { v: Number(v), s: bold ? 5 : 0 } : bold ? { v, s: 5 } : v);
  const rows = [
    [{ v: `Liu Vi · ${rep.title}`, s: 4 }], [rep.subtitle], [],
    rep.columns.map((c) => ({ v: c.label, s: 1 })),
    ...rep.rows.map((r) => r.map((v, i) => num(rep.columns[i].type, v, false))),
  ];
  if (rep.totals) rows.push(rep.totals.map((v, i) => num(rep.columns[i].type, v, true)));
  const widths = rep.columns.map((c, i) => Math.min(48, Math.max(c.type === 'text' ? 14 : 13, c.label.length + 3, ...rep.rows.slice(0, 200).map((r) => String(r[i] ?? '').length + 2))));
  return { name: rep.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), widths, rows };
}
