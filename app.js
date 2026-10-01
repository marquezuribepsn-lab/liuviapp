import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackups } from './backup.js';
import { appVersion } from './db.js';
import {
  PERMISSIONS, ALL_PERMISSIONS, MIN_PASSWORD, SESSION_HOURS,
  hashPassword, verifyPassword, newToken, hashToken, parseCookies, createLimiter,
} from './auth.js';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const METHODS = ['efectivo', 'tarjeta', 'transferencia'];
const COOKIE = 'liuvi_sid';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

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
  const backups = createBackups(db);
  const openSession = () => db.prepare('SELECT * FROM cash_sessions WHERE closed_at IS NULL').get();
  const requireSession = () => {
    const s = openSession();
    if (!s) throw new HttpError(409, 'La caja está cerrada. Abrí la caja para operar.');
    return s;
  };

  const ART = 'SELECT a.*, b.name AS brand FROM articles a LEFT JOIN brands b ON b.id = a.brand_id';

  // Busca la marca sin distinguir mayúsculas; si no existe, la crea (evita duplicados por tipeo).
  function resolveBrand(name) {
    const n = String(name ?? '').trim();
    if (!n) return null;
    if (n.length > 40) throw bad('La marca no puede superar los 40 caracteres');
    const found = db.prepare('SELECT id FROM brands WHERE name = ?').get(n);
    return found ? found.id : db.prepare('INSERT INTO brands (name) VALUES (?)').run(n).lastInsertRowid;
  }

  function articleFields(b, current = {}, canCost = true) {
    const name = String(b.name ?? current.name ?? '').trim();
    if (!name) throw bad('El nombre es obligatorio');
    const barcode = String(b.barcode ?? current.barcode ?? '').trim() || null;
    return {
      barcode, name,
      category: String(b.category ?? current.category ?? '').trim(),
      size: String(b.size ?? current.size ?? '').trim(),
      color: String(b.color ?? current.color ?? '').trim(),
      price: num(b.price ?? current.price, 'Precio'),
      cost: canCost ? num(b.cost ?? current.cost ?? 0, 'Costo') : (current.cost ?? 0),
      min_stock: num(b.min_stock ?? current.min_stock ?? 0, 'Stock mínimo', { int: true }),
    };
  }

  function moveStock(articleId, qty, reason, saleId = null, userId = null) {
    db.prepare('UPDATE articles SET stock = stock + ? WHERE id = ?').run(qty, articleId);
    db.prepare('INSERT INTO stock_movements (article_id, qty, reason, ref_sale_id, user_id) VALUES (?,?,?,?,?)')
      .run(articleId, qty, reason, saleId, userId);
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
    const who = (id) => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name ?? null : null);
    const sales = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM sales WHERE session_id=? AND voided=0').get(s.id);
    return {
      ...s, byMethod, opened_by_name: who(s.opened_by), closed_by_name: who(s.closed_by),
      sales_count: sales.n, sales_total: sales.t,
      expected_cash_now: round2(s.opening_amount + byMethod.efectivo.neto),
    };
  }

  // ---------- Rutas ----------
  const routes = [];
  // perm: 'public' (sin sesión), null (cualquier usuario con sesión), un permiso, o una lista (alcanza con uno).
  const route = (method, pattern, perm, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, perm, handler });
  };
  const maskCost = (v, can) => {
    if (can('costos.ver') || !v) return v;
    const strip = ({ cost, ...rest }) => rest;
    return Array.isArray(v) ? v.map(strip) : strip(v);
  };

  // Artículos
  route('GET', '/api/articles', ['articulos.ver', 'stock.ver'], ({ query, can }) => {
    const q = `%${(query.get('q') || '').trim()}%`;
    const all = query.get('all') === '1';
    const low = query.get('low') === '1';
    const brand = query.get('brand_id') || null;
    return maskCost(db.prepare(`
      ${ART}
      WHERE (? OR a.active = 1) AND (a.name LIKE ? OR a.barcode LIKE ? OR a.category LIKE ? OR a.color LIKE ? OR a.size LIKE ? OR b.name LIKE ?)
        AND (? = 0 OR a.stock <= a.min_stock) AND (? IS NULL OR a.brand_id = ?)
      ORDER BY b.name, a.name, a.size LIMIT 500
    `).all(all ? 1 : 0, q, q, q, q, q, q, low ? 1 : 0, brand, brand), can);
  });

  route('GET', '/api/articles/barcode/:code', ['articulos.ver', 'stock.ver'], ({ params, can }) => {
    const a = db.prepare(`${ART} WHERE a.barcode = ? AND a.active = 1`).get(decodeURIComponent(params.code));
    if (!a) throw new HttpError(404, 'Código no encontrado');
    return maskCost(a, can);
  });

  route('POST', '/api/articles', 'articulos.editar', ({ body, user, can }) => {
    const f = articleFields(body, {}, can('costos.ver'));
    const stock = num(body.stock ?? 0, 'Stock', { int: true });
    return tx(db, () => {
      try {
        const { lastInsertRowid: id } = db.prepare(`
          INSERT INTO articles (barcode,name,category,size,color,price,cost,stock,min_stock,brand_id)
          VALUES (?,?,?,?,?,?,?,0,?,?)`).run(f.barcode, f.name, f.category, f.size, f.color, f.price, f.cost, f.min_stock, resolveBrand(body.brand));
        if (stock) moveStock(id, stock, 'inicial', null, user.id);
        return { status: 201, data: maskCost(db.prepare(`${ART} WHERE a.id=?`).get(id), can) };
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw bad('Ya existe un artículo con ese código de barras');
        throw e;
      }
    });
  });

  route('PUT', '/api/articles/:id', 'articulos.editar', ({ params, body, can }) => {
    const cur = db.prepare('SELECT * FROM articles WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'Artículo no encontrado');
    const f = articleFields(body, cur, can('costos.ver'));
    try {
      const brandId = body.brand === undefined ? cur.brand_id : resolveBrand(body.brand);
      db.prepare(`UPDATE articles SET barcode=?,name=?,category=?,size=?,color=?,price=?,cost=?,min_stock=?,active=?,brand_id=? WHERE id=?`)
        .run(f.barcode, f.name, f.category, f.size, f.color, f.price, f.cost, f.min_stock, body.active === undefined ? cur.active : (body.active ? 1 : 0), brandId, cur.id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Ya existe un artículo con ese código de barras');
      throw e;
    }
    return maskCost(db.prepare(`${ART} WHERE a.id=?`).get(cur.id), can);
  });

  // Baja lógica: conserva el historial de ventas.
  route('DELETE', '/api/articles/:id', 'articulos.editar', ({ params }) => {
    const r = db.prepare('UPDATE articles SET active = 0 WHERE id = ?').run(params.id);
    if (!r.changes) throw new HttpError(404, 'Artículo no encontrado');
    return { ok: true };
  });

  // Marcas
  route('GET', '/api/brands', ['articulos.ver', 'stock.ver'], () => db.prepare(`
    SELECT b.id, b.name, COUNT(a.id) AS articles FROM brands b
    LEFT JOIN articles a ON a.brand_id = b.id AND a.active = 1 GROUP BY b.id ORDER BY b.name`).all());

  const brandName = (n) => {
    const v = String(n ?? '').trim();
    if (!v || v.length > 40) throw bad('El nombre de la marca es obligatorio (máx. 40 caracteres)');
    return v;
  };
  route('POST', '/api/brands', 'articulos.editar', ({ body }) => {
    try { return { status: 201, data: { id: db.prepare('INSERT INTO brands (name) VALUES (?)').run(brandName(body.name)).lastInsertRowid } }; }
    catch (e) { if (/UNIQUE/.test(e.message)) throw bad('Ya existe una marca con ese nombre'); throw e; }
  });
  route('PUT', '/api/brands/:id', 'articulos.editar', ({ params, body }) => {
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(params.id)) throw new HttpError(404, 'Marca no encontrada');
    try { db.prepare('UPDATE brands SET name=? WHERE id=?').run(brandName(body.name), params.id); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw bad('Ya existe una marca con ese nombre'); throw e; }
    return { ok: true };
  });
  // Solo se borra una marca sin artículos (ni siquiera dados de baja), para no perder el historial.
  route('DELETE', '/api/brands/:id', 'articulos.editar', ({ params }) => {
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(params.id)) throw new HttpError(404, 'Marca no encontrada');
    if (db.prepare('SELECT 1 FROM articles WHERE brand_id=?').get(params.id)) throw new HttpError(409, 'Hay artículos con esta marca: cambialos de marca antes de borrarla');
    db.prepare('DELETE FROM brands WHERE id=?').run(params.id);
    return { ok: true };
  });

  // Stock
  route('POST', '/api/stock/adjust', 'stock.ajustar', ({ body, user, can }) => {
    const qty = num(body.qty, 'Cantidad', { min: -1e9, int: true });
    if (qty === 0) throw bad('La cantidad no puede ser 0');
    const reason = ['compra', 'ajuste', 'devolucion'].includes(body.reason) ? body.reason : 'ajuste';
    return tx(db, () => {
      const a = db.prepare('SELECT * FROM articles WHERE id=?').get(body.article_id);
      if (!a) throw new HttpError(404, 'Artículo no encontrado');
      if (a.stock + qty < 0) throw bad(`Stock insuficiente (hay ${a.stock})`);
      moveStock(a.id, qty, reason, null, user.id);
      return maskCost(db.prepare(`${ART} WHERE a.id=?`).get(a.id), can);
    });
  });

  route('GET', '/api/stock/movements', 'stock.ver', ({ query }) => {
    const id = query.get('article_id');
    return db.prepare(`
      SELECT m.*, a.name, a.size, a.color, u.name AS user_name FROM stock_movements m JOIN articles a ON a.id = m.article_id
      LEFT JOIN users u ON u.id = m.user_id
      WHERE (? IS NULL OR m.article_id = ?) ORDER BY m.id DESC LIMIT 200
    `).all(id, id);
  });

  route('GET', '/api/stock/summary', 'stock.ver', ({ can }) => { const r = db.prepare(`
    SELECT COUNT(*) AS skus, COALESCE(SUM(stock),0) AS units,
           COALESCE(SUM(stock*cost),0) AS cost_value, COALESCE(SUM(stock*price),0) AS retail_value,
           COALESCE(SUM(CASE WHEN stock <= min_stock THEN 1 ELSE 0 END),0) AS low
    FROM articles WHERE active = 1`).get();
    if (!can('costos.ver')) r.cost_value = null;
    return r;
  });

  // Caja
  route('GET', '/api/cash/current', ['caja.ver', 'caja.operar', 'ventas.cobrar'], ({ can }) => {
    const s = openSession();
    if (!s) return null;
    // Quien solo vende ve que la caja está abierta, pero no cuánto efectivo hay.
    return can('caja.ver') || can('caja.operar') ? sessionSummary(s) : { id: s.id, opened_at: s.opened_at };
  });

  route('POST', '/api/cash/open', 'caja.operar', ({ body, user }) => {
    const amount = num(body.amount ?? 0, 'Monto inicial');
    return tx(db, () => {
      if (openSession()) throw new HttpError(409, 'Ya hay una caja abierta');
      const { lastInsertRowid: id } = db.prepare('INSERT INTO cash_sessions (opening_amount, opened_by) VALUES (?,?)').run(amount, user.id);
      return { status: 201, data: sessionSummary(db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(id)) };
    });
  });

  route('POST', '/api/cash/close', 'caja.operar', ({ body, user }) => {
    const counted = num(body.counted, 'Efectivo contado');
    const result = tx(db, () => {
      const s = requireSession();
      const sum = sessionSummary(s);
      db.prepare(`UPDATE cash_sessions SET closed_at = datetime('now','localtime'), expected_cash=?, counted_cash=?, note=?, closed_by=? WHERE id=?`)
        .run(sum.expected_cash_now, counted, String(body.note || ''), user.id, s.id);
      const closed = sessionSummary(db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(s.id));
      return { ...closed, difference: round2(counted - sum.expected_cash_now) };
    });
    backups.tryRun('cierre de caja'); // el cierre es un buen momento para resguardar el día
    return result;
  });

  route('POST', '/api/cash/movement', 'caja.operar', ({ body, user }) => {
    const s = requireSession();
    if (!['ingreso', 'egreso'].includes(body.type)) throw bad('Tipo inválido');
    const method = body.method || 'efectivo';
    if (!METHODS.includes(method)) throw bad('Medio de pago inválido');
    const amount = num(body.amount, 'Monto');
    if (amount <= 0) throw bad('El monto debe ser mayor a 0');
    const concept = String(body.concept || '').trim();
    if (!concept) throw bad('Indicá el concepto');
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO cash_movements (session_id,type,method,amount,concept,user_id) VALUES (?,?,?,?,?,?)').run(s.id, body.type, method, amount, concept, user.id);
    return { status: 201, data: db.prepare('SELECT * FROM cash_movements WHERE id=?').get(id) };
  });

  route('GET', '/api/cash/movements', 'caja.ver', ({ query }) => {
    const sid = query.get('session_id') || openSession()?.id;
    if (!sid) return [];
    return db.prepare(`SELECT m.*, u.name AS user_name FROM cash_movements m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.session_id=? ORDER BY m.id DESC`).all(sid);
  });

  route('GET', '/api/cash/sessions', 'caja.ver', () =>
    db.prepare('SELECT * FROM cash_sessions ORDER BY id DESC LIMIT 60').all().map(sessionSummary));

  // Ventas
  route('POST', '/api/sales', 'ventas.cobrar', ({ body, user }) => {
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
        const a = db.prepare(`${ART} WHERE a.id=? AND a.active=1`).get(id);
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
        'INSERT INTO sales (session_id,subtotal,discount,total,user_id) VALUES (?,?,?,?,?)').run(session.id, subtotal, discount, total, user.id);
      for (const { a, qty } of lines) {
        const label = [a.brand, a.name, a.size, a.color].filter(Boolean).join(' · ');
        db.prepare('INSERT INTO sale_items (sale_id,article_id,name,qty,price,cost,brand) VALUES (?,?,?,?,?,?,?)')
          .run(saleId, a.id, label, qty, a.price, a.cost, a.brand);
        moveStock(a.id, -qty, 'venta', saleId, user.id);
      }
      for (const p of finalPayments) {
        db.prepare('INSERT INTO sale_payments (sale_id,method,amount) VALUES (?,?,?)').run(saleId, p.method, p.amount);
        db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?,?,?)')
          .run(session.id, 'ingreso', p.method, p.amount, `Venta #${saleId}`, saleId, user.id);
      }
      return { status: 201, data: { id: saleId, subtotal, discount, total, change, payments: finalPayments } };
    });
  });

  route('GET', '/api/sales', ['ventas.cobrar', 'caja.ver'], ({ query }) => {
    const date = query.get('date') || new Date().toLocaleDateString('sv-SE');
    const sales = db.prepare(`SELECT s.*, u.name AS seller FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE date(s.created_at) = ? ORDER BY s.id DESC`).all(date);
    for (const s of sales) {
      s.items = db.prepare('SELECT name,qty,price FROM sale_items WHERE sale_id=?').all(s.id);
      s.payments = db.prepare('SELECT method,amount FROM sale_payments WHERE sale_id=?').all(s.id);
    }
    return sales;
  });

  route('POST', '/api/sales/:id/void', 'ventas.anular', ({ params, user }) => tx(db, () => {
    const session = requireSession();
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(params.id);
    if (!sale) throw new HttpError(404, 'Venta no encontrada');
    if (sale.voided) throw new HttpError(409, 'La venta ya está anulada');
    db.prepare('UPDATE sales SET voided=1 WHERE id=?').run(sale.id);
    for (const it of db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(sale.id)) moveStock(it.article_id, it.qty, 'anulacion', sale.id, user.id);
    // El reintegro sale de la caja abierta hoy, aunque la venta sea de una caja anterior.
    for (const p of db.prepare('SELECT * FROM sale_payments WHERE sale_id=?').all(sale.id)) {
      db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?,?,?)')
        .run(session.id, 'egreso', p.method, p.amount, `Anulación venta #${sale.id}`, sale.id, user.id);
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

  route('GET', '/api/stats/series', 'estadisticas.ver', ({ query, can }) => {
    const g = GROUPS[query.get('group') || 'day'];
    if (!g) throw bad('Agrupación inválida');
    const rows = db.prepare(`
      SELECT strftime('${g.fmt}', s.created_at) AS period,
             COUNT(*) AS sales, ROUND(SUM(s.total),2) AS total,
             COALESCE(SUM((SELECT SUM(qty) FROM sale_items WHERE sale_id = s.id)),0) AS units,
             ROUND(SUM(s.total - COALESCE((SELECT SUM(qty*cost) FROM sale_items WHERE sale_id = s.id),0)),2) AS profit
      FROM sales s WHERE s.voided = 0 GROUP BY period ORDER BY period DESC LIMIT ?`).all(g.limit);
    return rows.reverse().map((r) => ({ ...r, profit: can('costos.ver') ? r.profit : null, avg_ticket: r.sales ? round2(r.total / r.sales) : 0 }));
  });

  route('GET', '/api/stats/breakdown', 'estadisticas.ver', ({ query, can }) => {
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
    const bySeller = db.prepare(`
      SELECT COALESCE(u.name, 'Sin usuario') AS seller, COUNT(*) AS sales, ROUND(SUM(s.total),2) AS total
      FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE ${inPeriod} GROUP BY s.user_id ORDER BY total DESC`).all(cur);
    // A precio de lista (antes de descuentos), igual que «más vendidos». La ganancia solo con permiso de costos.
    const byBrand = db.prepare(`
      SELECT COALESCE(i.brand, 'Sin marca') AS brand, SUM(i.qty) AS units, ROUND(SUM(i.qty*i.price),2) AS total,
             ROUND(SUM(i.qty*(i.price-i.cost)),2) AS profit
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${inPeriod}
      GROUP BY COALESCE(i.brand, 'Sin marca') ORDER BY total DESC`).all(cur)
      .map((r) => ({ ...r, profit: can('costos.ver') ? r.profit : null }));
    return { period: cur, ...totals, byMethod, topArticles, bySeller, byBrand };
  });


  // ---------- Autenticación ----------
  const limiter = createLimiter();
  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role_name, permissions: u.permissions });

  function permsOf(role) {
    if (role.is_admin) return [...ALL_PERMISSIONS];
    try { return JSON.parse(role.permissions).filter((p) => ALL_PERMISSIONS.includes(p)); } catch { return []; }
  }

  // Usuario de la sesión actual (con sus permisos leídos en este momento, así un cambio de rol rige de inmediato).
  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.id, u.username, u.name, u.active, r.name AS role_name, r.permissions, r.is_admin, s.expires_at, s.token_hash
      FROM user_sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = ?`).get(hashToken(token));
    if (!row || !row.active || row.expires_at < localNow()) return null;
    return { ...row, permissions: permsOf(row) };
  }
  const localNow = (offsetHours = 0) => new Date(Date.now() + offsetHours * 3600_000).toLocaleString('sv-SE');

  function startSession(res, userId) {
    const token = newToken();
    db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(localNow());
    db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(hashToken(token), userId, localNow(SESSION_HOURS));
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
  }
  const userFull = (id) => {
    const u = db.prepare('SELECT u.id,u.username,u.name,r.name AS role_name,r.permissions,r.is_admin FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?').get(id);
    return publicUser({ ...u, permissions: permsOf(u) });
  };
  const checkPassword = (pw) => {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw bad(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
    return pw;
  };
  const checkUsername = (u) => {
    const v = String(u || '').trim();
    if (!/^[\p{L}\p{N}._-]{3,32}$/u.test(v)) throw bad('Usuario inválido: 3 a 32 letras, números, punto, guion o guion bajo');
    return v;
  };
  // Siempre debe quedar al menos un usuario activo que pueda administrar usuarios y roles.
  function assertAdminRemains() {
    const roles = new Map(db.prepare('SELECT * FROM roles').all().map((r) => [r.id, r]));
    const ok = db.prepare('SELECT role_id FROM users WHERE active = 1').all().some((u) => permsOf(roles.get(u.role_id)).includes('usuarios.admin'));
    if (!ok) throw bad('Tiene que quedar al menos un usuario activo con permiso para administrar usuarios y roles');
  }

  route('GET', '/api/auth/me', 'public', ({ user }) => {
    const setupNeeded = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    // Mientras no hay usuarios se informa dónde se busca la base (ayuda a detectar que se abrió otra copia del programa).
    const dbFile = setupNeeded ? db.prepare('PRAGMA database_list').get()?.file || undefined : undefined;
    return { setupNeeded, version: appVersion(), dbFile, user: user ? publicUser(user) : null, permissions: PERMISSIONS };
  });

  route('POST', '/api/auth/setup', 'public', ({ body, res }) => tx(db, () => {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409, 'El sistema ya tiene usuarios');
    const username = checkUsername(body.username);
    const name = String(body.name || '').trim() || username;
    const role = db.prepare('SELECT id FROM roles WHERE is_admin = 1').get();
    const { lastInsertRowid: id } = db.prepare('INSERT INTO users (username,name,password_hash,role_id) VALUES (?,?,?,?)')
      .run(username, name, hashPassword(checkPassword(body.password)), role.id);
    startSession(res, id);
    return { status: 201, data: { user: userFull(id) } };
  }));

  route('POST', '/api/auth/login', 'public', ({ body, req, res }) => {
    const username = String(body.username || '').trim();
    const key = `${username.toLowerCase()}|${req.socket.remoteAddress}`;
    const wait = limiter.check(key);
    if (wait) throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${wait} segundos.`);
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!verifyPassword(String(body.password || ''), u?.password_hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    limiter.ok(key);
    startSession(res, u.id);
    return { user: userFull(u.id) };
  });

  route('POST', '/api/auth/logout', null, ({ req, res }) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  route('POST', '/api/auth/password', null, ({ body, user, req }) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if (!verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(403, 'La contraseña actual no es correcta');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(checkPassword(body.next)), user.id);
    // Cierra las demás sesiones de este usuario; la actual sigue abierta.
    db.prepare('DELETE FROM user_sessions WHERE user_id=? AND token_hash<>?').run(user.id, hashToken(parseCookies(req.headers.cookie)[COOKIE]));
    return { ok: true };
  });

  // ---------- Usuarios y roles (solo administradores) ----------
  const roleRow = (r, count) => ({ id: r.id, name: r.name, is_admin: !!r.is_admin, permissions: permsOf(r), users: count });
  const ADMIN = 'usuarios.admin';

  route('GET', '/api/users', ADMIN, () => db.prepare(`
    SELECT u.id,u.username,u.name,u.active,u.role_id,r.name AS role_name,u.created_at FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.active DESC, u.name`).all());

  route('POST', '/api/users', ADMIN, ({ body }) => {
    const username = checkUsername(body.username);
    const name = String(body.name || '').trim();
    if (!name) throw bad('El nombre es obligatorio');
    if (!db.prepare('SELECT 1 FROM roles WHERE id=?').get(body.role_id)) throw bad('Rol inválido');
    try {
      const { lastInsertRowid: id } = db.prepare('INSERT INTO users (username,name,password_hash,role_id) VALUES (?,?,?,?)')
        .run(username, name, hashPassword(checkPassword(body.password)), body.role_id);
      return { status: 201, data: { id } };
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Ya existe un usuario con ese nombre de usuario');
      throw e;
    }
  });

  route('PUT', '/api/users/:id', ADMIN, ({ params, body, user }) => tx(db, () => {
    const cur = db.prepare('SELECT * FROM users WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'Usuario no encontrado');
    const name = String(body.name ?? cur.name).trim();
    if (!name) throw bad('El nombre es obligatorio');
    const roleId = body.role_id ?? cur.role_id;
    if (!db.prepare('SELECT 1 FROM roles WHERE id=?').get(roleId)) throw bad('Rol inválido');
    const active = body.active === undefined ? cur.active : (body.active ? 1 : 0);
    if (cur.id === user.id && !active) throw bad('No podés desactivar tu propio usuario');
    db.prepare('UPDATE users SET name=?, role_id=?, active=? WHERE id=?').run(name, roleId, active, cur.id);
    if (body.password) {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(checkPassword(body.password)), cur.id);
      db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(cur.id);
    }
    if (!active) db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(cur.id);
    assertAdminRemains();
    return { ok: true };
  }));

  route('GET', '/api/roles', ADMIN, () => {
    const counts = Object.fromEntries(db.prepare('SELECT role_id, COUNT(*) n FROM users WHERE active=1 GROUP BY role_id').all().map((r) => [r.role_id, r.n]));
    return db.prepare('SELECT * FROM roles ORDER BY is_admin DESC, name').all().map((r) => roleRow(r, counts[r.id] || 0));
  });

  const rolePerms = (b) => {
    if (!Array.isArray(b.permissions)) throw bad('Permisos inválidos');
    const list = [...new Set(b.permissions)];
    if (list.some((p) => !ALL_PERMISSIONS.includes(p))) throw bad('Permiso desconocido');
    return list;
  };
  const roleName = (n) => {
    const v = String(n || '').trim();
    if (!v || v.length > 40) throw bad('El nombre del rol es obligatorio (máx. 40 caracteres)');
    return v;
  };

  route('POST', '/api/roles', ADMIN, ({ body }) => {
    try {
      const { lastInsertRowid: id } = db.prepare('INSERT INTO roles (name, permissions) VALUES (?,?)').run(roleName(body.name), JSON.stringify(rolePerms(body)));
      return { status: 201, data: { id } };
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Ya existe un rol con ese nombre');
      throw e;
    }
  });

  route('PUT', '/api/roles/:id', ADMIN, ({ params, body }) => tx(db, () => {
    const cur = db.prepare('SELECT * FROM roles WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'Rol no encontrado');
    if (cur.is_admin) throw bad('El rol Administrador no se puede modificar: siempre tiene todos los permisos');
    try {
      db.prepare('UPDATE roles SET name=?, permissions=? WHERE id=?').run(roleName(body.name ?? cur.name), JSON.stringify(body.permissions === undefined ? permsOf(cur) : rolePerms(body)), cur.id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw bad('Ya existe un rol con ese nombre');
      throw e;
    }
    assertAdminRemains();
    return { ok: true };
  }));

  route('DELETE', '/api/roles/:id', ADMIN, ({ params }) => tx(db, () => {
    const cur = db.prepare('SELECT * FROM roles WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'Rol no encontrado');
    if (cur.is_admin) throw bad('El rol Administrador no se puede eliminar');
    if (db.prepare('SELECT 1 FROM users WHERE role_id=?').get(cur.id)) throw new HttpError(409, 'Hay usuarios con este rol: reasignalos antes de eliminarlo');
    db.prepare('DELETE FROM roles WHERE id=?').run(cur.id);
    return { ok: true };
  }));

  // ---------- Copias de seguridad ----------
  const BACKUP = 'sistema.copias';
  route('GET', '/api/backup', BACKUP, () => backups.status());
  route('PUT', '/api/backup', BACKUP, ({ body }) => {
    try { backups.configure({ dir: body.dir, auto: body.auto }); } catch (e) { throw bad(e.message); }
    return backups.status();
  });
  route('POST', '/api/backup/run', BACKUP, () => {
    try { backups.run('manual'); } catch (e) { throw bad(e.message); }
    return backups.status();
  });

  // ---------- Despacho ----------
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw bad('JSON inválido'); }
  }

  async function handle(req, res) {
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
          const user = sessionUser(req);
          const can = (p) => !!user && user.permissions.includes(p);
          if (r.perm !== 'public') {
            if (!user) throw new HttpError(401, 'Iniciá sesión para continuar');
            if (r.perm && ![].concat(r.perm).some(can)) throw new HttpError(403, 'No tenés permiso para hacer esto');
          }
          // Defensa extra contra CSRF: las escrituras solo se aceptan como JSON (un form de otro sitio no puede enviarlo).
          if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) throw bad('Content-Type inválido');
          const body = req.method === 'GET' ? {} : await readBody(req);
          const out = r.handler({ params, query: url.searchParams, body, user, can, req, res });
          return out && out.status && out.data !== undefined ? send(out.status, out.data) : send(200, out ?? null);
        }
        throw new HttpError(404, 'Ruta no encontrada');
      }
      // Archivos estáticos
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); return res.end('No encontrado'); }
      const type = MIME[extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, ...(type.startsWith('image/') && { 'Cache-Control': 'public, max-age=86400' }) });
      res.end(readFileSync(file));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Error interno' });
    }
  }
  handle.backups = backups;
  return handle;
}
