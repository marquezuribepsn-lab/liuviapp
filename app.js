import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const METHODS = ['efectivo', 'tarjeta', 'transferencia'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const round2 = (n) => Math.round(n * 100) / 100;

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function num(v, name, { min = 0, int = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw bad(`${name} inválido`);
  if (n < min) throw bad(`${name} no puede ser menor a ${min}`);
  if (int && !Number.isInteger(n)) throw bad(`${name} debe ser entero`);
  return n;
}

export function createApp(db) {
  const openSession = () => db.prepare('SELECT * FROM cash_sessions WHERE closed_at IS NULL').get();
  const requireSession = () => {
    const s = openSession();
    if (!s) throw new HttpError(409, 'La caja está cerrada. Abrí la caja para operar.');
    return s;
  };

  function articleFields(b, current = {}) {
    const name = String(b.name ?? current.name ?? '').trim();
    if (!name) throw bad('El nombre es obligatorio');
    const barcode = String(b.barcode ?? current.barcode ?? '').trim() || null;
    return {
      barcode, name,
      category: String(b.category ?? current.category ?? '').trim(),
      size: String(b.size ?? current.size ?? '').trim(),
      color: String(b.color ?? current.color ?? '').trim(),
      price: num(b.price ?? current.price, 'Precio'),
      cost: num(b.cost ?? current.cost ?? 0, 'Costo'),
      min_stock: num(b.min_stock ?? current.min_stock ?? 0, 'Stock mínimo', { int: true }),
    };
  }

  function moveStock(articleId, qty, reason, saleId = null) {
    db.prepare('UPDATE articles SET stock = stock + ? WHERE id = ?').run(qty, articleId);
    db.prepare('INSERT INTO stock_movements (article_id, qty, reason, ref_sale_id) VALUES (?,?,?,?)')
      .run(articleId, qty, reason, saleId);
  }

  function sessionTotals(sessionId) {
    const rows = db.prepare(`
      SELECT type, method, SUM(amount) AS total FROM cash_movements WHERE session_id = ? GROUP BY type, method
    `).all(sessionId);
    const byMethod = Object.fromEntries(METHODS.map((m) => [m, { ingresos: 0, egresos: 0, neto: 0 }]));
    for (const r of rows) byMethod[r.method][r.type === 'ingreso' ? 'ingresos' : 'egresos'] = r.total;
    for (const m of METHODS) byMethod[m].neto = round2(byMethod[m].ingresos - byMethod[m].egresos);
    return byMethod;
  }

  function sessionSummary(s) {
    const byMethod = sessionTotals(s.id);
    const sales = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM sales WHERE session_id=? AND voided=0').get(s.id);
    return {
      ...s, byMethod,
      sales_count: sales.n, sales_total: sales.t,
      expected_cash_now: round2(s.opening_amount + byMethod.efectivo.neto),
    };
  }

  // ---------- Rutas ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  // Artículos
  route('GET', '/api/articles', ({ query }) => {
    const q = `%${(query.get('q') || '').trim()}%`;
    const all = query.get('all') === '1';
    const low = query.get('low') === '1';
    return db.prepare(`
      SELECT * FROM articles
      WHERE (? OR active = 1) AND (name LIKE ? OR barcode LIKE ? OR category LIKE ? OR color LIKE ? OR size LIKE ?)
        AND (? = 0 OR stock <= min_stock)
      ORDER BY name, size LIMIT 500
    `).all(all ? 1 : 0, q, q, q, q, q, low ? 1 : 0);
  });

  route('GET', '/api/articles/barcode/:code', ({ params }) => {
    const a = db.prepare('SELECT * FROM articles WHERE barcode = ? AND active = 1').get(decodeURIComponent(params.code));
    if (!a) throw new HttpError(404, 'Código no encontrado');
    return a;
  });

  route('POST', '/api/articles', ({ body }) => {
    const f = articleFields(body);
    const stock = num(body.stock ?? 0, 'Stock', { int: true });
    return tx(db, () => {
      try {
        const { lastInsertRowid: id } = db.prepare(`
          INSERT INTO articles (barcode,name,category,size,color,price,cost,stock,min_stock)
          VALUES (?,?,?,?,?,?,?,0,?)`).run(f.barcode, f.name, f.category, f.size, f.color, f.price, f.cost, f.min_stock);
        if (stock) moveStock(id, stock, 'inicial');
        return { status: 201, data: db.prepare('SELECT * FROM articles WHERE id=?').get(id) };
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw bad('Ya existe un artículo con ese código de barras');
        throw e;
      }
    });
  });

  route('PUT', '/api/articles/:id', ({ params, body }) => {
    const cur = db.prepare('SELECT * FROM articles WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'Artículo no encontrado');
    const f = articleFields(body, cur);
    try {
      db.prepare(`UPDATE articles SET barcode=?,name=?,category=?,size=?,color=?,price=?,cost=?,min_stock=?,active=? WHERE id=?`)
        .run(f.barcode, f.name, f.category, f.size, f.color, f.price, f.cost, f.min_stock, body.active === undefined ? cur.active : (body.active ? 1 : 0), cur.id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Ya existe un artículo con ese código de barras');
      throw e;
    }
    return db.prepare('SELECT * FROM articles WHERE id=?').get(cur.id);
  });

  // Baja lógica: conserva el historial de ventas.
  route('DELETE', '/api/articles/:id', ({ params }) => {
    const r = db.prepare('UPDATE articles SET active = 0 WHERE id = ?').run(params.id);
    if (!r.changes) throw new HttpError(404, 'Artículo no encontrado');
    return { ok: true };
  });

  // Stock
  route('POST', '/api/stock/adjust', ({ body }) => {
    const qty = num(body.qty, 'Cantidad', { min: -1e9, int: true });
    if (qty === 0) throw bad('La cantidad no puede ser 0');
    const reason = ['compra', 'ajuste', 'devolucion'].includes(body.reason) ? body.reason : 'ajuste';
    return tx(db, () => {
      const a = db.prepare('SELECT * FROM articles WHERE id=?').get(body.article_id);
      if (!a) throw new HttpError(404, 'Artículo no encontrado');
      if (a.stock + qty < 0) throw bad(`Stock insuficiente (hay ${a.stock})`);
      moveStock(a.id, qty, reason);
      return db.prepare('SELECT * FROM articles WHERE id=?').get(a.id);
    });
  });

  route('GET', '/api/stock/movements', ({ query }) => {
    const id = query.get('article_id');
    return db.prepare(`
      SELECT m.*, a.name, a.size, a.color FROM stock_movements m JOIN articles a ON a.id = m.article_id
      WHERE (? IS NULL OR m.article_id = ?) ORDER BY m.id DESC LIMIT 200
    `).all(id, id);
  });

  route('GET', '/api/stock/summary', () => db.prepare(`
    SELECT COUNT(*) AS skus, COALESCE(SUM(stock),0) AS units,
           COALESCE(SUM(stock*cost),0) AS cost_value, COALESCE(SUM(stock*price),0) AS retail_value,
           COALESCE(SUM(CASE WHEN stock <= min_stock THEN 1 ELSE 0 END),0) AS low
    FROM articles WHERE active = 1`).get());

  // Caja
  route('GET', '/api/cash/current', () => {
    const s = openSession();
    return s ? sessionSummary(s) : null;
  });

  route('POST', '/api/cash/open', ({ body }) => {
    const amount = num(body.amount ?? 0, 'Monto inicial');
    return tx(db, () => {
      if (openSession()) throw new HttpError(409, 'Ya hay una caja abierta');
      const { lastInsertRowid: id } = db.prepare('INSERT INTO cash_sessions (opening_amount) VALUES (?)').run(amount);
      return { status: 201, data: sessionSummary(db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(id)) };
    });
  });

  route('POST', '/api/cash/close', ({ body }) => {
    const counted = num(body.counted, 'Efectivo contado');
    return tx(db, () => {
      const s = requireSession();
      const sum = sessionSummary(s);
      db.prepare(`UPDATE cash_sessions SET closed_at = datetime('now','localtime'), expected_cash=?, counted_cash=?, note=? WHERE id=?`)
        .run(sum.expected_cash_now, counted, String(body.note || ''), s.id);
      const closed = sessionSummary(db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(s.id));
      return { ...closed, difference: round2(counted - sum.expected_cash_now) };
    });
  });

  route('POST', '/api/cash/movement', ({ body }) => {
    const s = requireSession();
    if (!['ingreso', 'egreso'].includes(body.type)) throw bad('Tipo inválido');
    const method = body.method || 'efectivo';
    if (!METHODS.includes(method)) throw bad('Medio de pago inválido');
    const amount = num(body.amount, 'Monto');
    if (amount <= 0) throw bad('El monto debe ser mayor a 0');
    const concept = String(body.concept || '').trim();
    if (!concept) throw bad('Indicá el concepto');
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO cash_movements (session_id,type,method,amount,concept) VALUES (?,?,?,?,?)').run(s.id, body.type, method, amount, concept);
    return { status: 201, data: db.prepare('SELECT * FROM cash_movements WHERE id=?').get(id) };
  });

  route('GET', '/api/cash/movements', ({ query }) => {
    const sid = query.get('session_id') || openSession()?.id;
    if (!sid) return [];
    return db.prepare('SELECT * FROM cash_movements WHERE session_id=? ORDER BY id DESC').all(sid);
  });

  route('GET', '/api/cash/sessions', () =>
    db.prepare('SELECT * FROM cash_sessions ORDER BY id DESC LIMIT 60').all().map(sessionSummary));

  // Ventas
  route('POST', '/api/sales', ({ body }) => {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw bad('La venta no tiene artículos');
    const payments = (Array.isArray(body.payments) ? body.payments : []).map((p) => {
      if (!METHODS.includes(p.method)) throw bad('Medio de pago inválido');
      return { method: p.method, amount: num(p.amount, 'Monto de pago') };
    }).filter((p) => p.amount > 0);
    if (!payments.length) throw bad('Indicá el medio de pago');
    const discountPct = num(body.discount_pct ?? 0, 'Descuento');
    if (discountPct > 100) throw bad('Descuento inválido');

    return tx(db, () => {
      const session = requireSession();
      const lines = [];
      const wanted = new Map();
      for (const it of items) {
        const qty = num(it.qty, 'Cantidad', { min: 1, int: true });
        wanted.set(it.article_id, (wanted.get(it.article_id) || 0) + qty);
      }
      let subtotal = 0;
      for (const [id, qty] of wanted) {
        const a = db.prepare('SELECT * FROM articles WHERE id=? AND active=1').get(id);
        if (!a) throw new HttpError(404, `Artículo ${id} no encontrado`);
        if (a.stock < qty) throw new HttpError(409, `Stock insuficiente de "${a.name}" ${a.size} (hay ${a.stock})`);
        lines.push({ a, qty });
        subtotal += a.price * qty;
      }
      subtotal = round2(subtotal);
      const discount = round2(subtotal * discountPct / 100);
      const total = round2(subtotal - discount);

      const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
      if (paid < total) throw bad(`Falta cobrar ${round2(total - paid).toFixed(2)}`);
      let change = round2(paid - total);
      if (change > 0) {
        // El vuelto solo puede salir del efectivo recibido.
        const cash = payments.find((p) => p.method === 'efectivo');
        if (!cash || cash.amount < change) throw bad('El pago excede el total y no hay efectivo para dar vuelto');
        cash.amount = round2(cash.amount - change);
      }
      const finalPayments = payments.filter((p) => p.amount > 0);

      const { lastInsertRowid: saleId } = db.prepare(
        'INSERT INTO sales (session_id,subtotal,discount,total) VALUES (?,?,?,?)').run(session.id, subtotal, discount, total);
      for (const { a, qty } of lines) {
        const label = [a.name, a.size, a.color].filter(Boolean).join(' · ');
        db.prepare('INSERT INTO sale_items (sale_id,article_id,name,qty,price,cost) VALUES (?,?,?,?,?,?)')
          .run(saleId, a.id, label, qty, a.price, a.cost);
        moveStock(a.id, -qty, 'venta', saleId);
      }
      for (const p of finalPayments) {
        db.prepare('INSERT INTO sale_payments (sale_id,method,amount) VALUES (?,?,?)').run(saleId, p.method, p.amount);
        db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,sale_id) VALUES (?,?,?,?,?,?)')
          .run(session.id, 'ingreso', p.method, p.amount, `Venta #${saleId}`, saleId);
      }
      return { status: 201, data: { id: saleId, subtotal, discount, total, change, payments: finalPayments } };
    });
  });

  route('GET', '/api/sales', ({ query }) => {
    const date = query.get('date') || new Date().toLocaleDateString('sv-SE');
    const sales = db.prepare(`SELECT * FROM sales WHERE date(created_at) = ? ORDER BY id DESC`).all(date);
    for (const s of sales) {
      s.items = db.prepare('SELECT name,qty,price FROM sale_items WHERE sale_id=?').all(s.id);
      s.payments = db.prepare('SELECT method,amount FROM sale_payments WHERE sale_id=?').all(s.id);
    }
    return sales;
  });

  route('POST', '/api/sales/:id/void', ({ params }) => tx(db, () => {
    const session = requireSession();
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(params.id);
    if (!sale) throw new HttpError(404, 'Venta no encontrada');
    if (sale.voided) throw new HttpError(409, 'La venta ya está anulada');
    db.prepare('UPDATE sales SET voided=1 WHERE id=?').run(sale.id);
    for (const it of db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(sale.id)) moveStock(it.article_id, it.qty, 'anulacion', sale.id);
    // El reintegro sale de la caja abierta hoy, aunque la venta sea de una caja anterior.
    for (const p of db.prepare('SELECT * FROM sale_payments WHERE sale_id=?').all(sale.id)) {
      db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,sale_id) VALUES (?,?,?,?,?,?)')
        .run(session.id, 'egreso', p.method, p.amount, `Anulación venta #${sale.id}`, sale.id);
    }
    return { ok: true };
  }));

  // Estadísticas
  const GROUPS = {
    day:   { fmt: '%Y-%m-%d', limit: 31 },
    week:  { fmt: '%Y-W%W',   limit: 12 },
    month: { fmt: '%Y-%m',    limit: 12 },
    year:  { fmt: '%Y',       limit: 10 },
  };

  route('GET', '/api/stats/series', ({ query }) => {
    const g = GROUPS[query.get('group') || 'day'];
    if (!g) throw bad('Agrupación inválida');
    const rows = db.prepare(`
      SELECT strftime('${g.fmt}', s.created_at) AS period,
             COUNT(*) AS sales, ROUND(SUM(s.total),2) AS total,
             COALESCE(SUM((SELECT SUM(qty) FROM sale_items WHERE sale_id = s.id)),0) AS units,
             ROUND(SUM(s.total - COALESCE((SELECT SUM(qty*cost) FROM sale_items WHERE sale_id = s.id),0)),2) AS profit
      FROM sales s WHERE s.voided = 0 GROUP BY period ORDER BY period DESC LIMIT ?`).all(g.limit);
    return rows.reverse().map((r) => ({ ...r, avg_ticket: r.sales ? round2(r.total / r.sales) : 0 }));
  });

  route('GET', '/api/stats/breakdown', ({ query }) => {
    const g = GROUPS[query.get('group') || 'day'];
    if (!g) throw bad('Agrupación inválida');
    // Período actual según la agrupación elegida.
    const cur = db.prepare(`SELECT strftime('${g.fmt}','now','localtime') AS p`).get().p;
    const inPeriod = `strftime('${g.fmt}', s.created_at) = ? AND s.voided = 0`;
    const totals = db.prepare(`SELECT COUNT(*) AS sales, COALESCE(ROUND(SUM(total),2),0) AS total FROM sales s WHERE ${inPeriod}`).get(cur);
    const byMethod = db.prepare(`
      SELECT p.method, ROUND(SUM(p.amount),2) AS total FROM sale_payments p JOIN sales s ON s.id = p.sale_id
      WHERE ${inPeriod} GROUP BY p.method`).all(cur);
    const topArticles = db.prepare(`
      SELECT i.name, SUM(i.qty) AS units, ROUND(SUM(i.qty*i.price),2) AS total
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${inPeriod}
      GROUP BY i.article_id ORDER BY units DESC LIMIT 10`).all(cur);
    return { period: cur, ...totals, byMethod, topArticles };
  });

  // ---------- Despacho ----------
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw bad('JSON inválido'); }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, data) => {
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          const body = req.method === 'GET' ? {} : await readBody(req);
          const out = r.handler({ params, query: url.searchParams, body });
          return out && out.status && out.data !== undefined ? send(out.status, out.data) : send(200, out ?? null);
        }
        throw new HttpError(404, 'Ruta no encontrada');
      }
      // Archivos estáticos
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); return res.end('No encontrado'); }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Error interno' });
    }
  };
}
