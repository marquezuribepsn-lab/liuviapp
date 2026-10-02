import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackups } from './backup.js';
import { createGoogleDrive } from './gdrive.js';
import { createImporter, ImportError, SheetFormatError } from './importer.js';
import { appVersion, getSetting, setSetting } from './db.js';
import {
  PERMISSIONS, ALL_PERMISSIONS, MIN_PASSWORD, SESSION_HOURS,
  hashPassword, verifyPassword, newToken, hashToken, parseCookies, createLimiter, PIN_RE, isWeakPin, isLoopback,
} from './auth.js';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const METHODS = ['efectivo', 'tarjeta', 'transferencia'];
const COOKIE = 'liuvi_sid';
const LOCK_OK = new Set(['/api/auth/unlock', '/api/auth/logout']); // con la sesión bloqueada solo se puede desbloquear o salir
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg) => new HttpError(400, msg);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round(n * 100) / 100;

// Las operaciones son síncronas: si ya hay una transacción abierta, la función se suma a ella.
let txDepth = 0;
function tx(db, fn) {
  if (txDepth) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { txDepth--; }
}

function num(v, name, { min = 0, int = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw bad(`${name} inválido`);
  if (n < min) throw bad(`${name} no puede ser menor a ${min}`);
  if (int && !Number.isInteger(n)) throw bad(`${name} debe ser entero`);
  return n;
}

export function createApp(db, opts = {}) {
  const gdrive = createGoogleDrive(db, opts.google);
  const dbFile = db.prepare('PRAGMA database_list').get()?.file;
  const backups = createBackups(db, { gdrive, defaultDir: dbFile ? join(dirname(dbFile), 'copias') : null });
  const openSession = () => db.prepare('SELECT * FROM cash_sessions WHERE closed_at IS NULL').get();
  const requireSession = () => {
    const s = openSession();
    if (!s) throw new HttpError(409, 'La caja está cerrada. Abrí la caja para operar.');
    return s;
  };

  // `reserved`: unidades apartadas (con seña) que todavía no se pueden vender a otro cliente.
  const ART = `SELECT a.*, b.name AS brand,
    COALESCE((SELECT SUM(li.qty) FROM layaway_items li JOIN layaways l ON l.id = li.layaway_id WHERE li.article_id = a.id AND l.status = 'open'),0) AS reserved
    FROM articles a LEFT JOIN brands b ON b.id = a.brand_id`;

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
    sales.t = round2(sales.t - db.prepare('SELECT COALESCE(SUM(value),0) AS v FROM returns WHERE session_id=?').get(s.id).v); // neto de devoluciones
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
  route('GET', '/api/articles', ['articulos.ver', 'stock.ver'], ({ query, can, res }) => {
    const q = `%${(query.get('q') || '').trim()}%`;
    const all = query.get('all') === '1';
    const low = query.get('low') === '1';
    const brand = query.get('brand_id') || null;
    const where = `
      WHERE (? OR a.active = 1) AND (a.name LIKE ? OR a.barcode LIKE ? OR a.category LIKE ? OR a.color LIKE ? OR a.size LIKE ? OR b.name LIKE ?)
        AND (? = 0 OR a.stock <= a.min_stock) AND (? IS NULL OR a.brand_id = ?)`;
    const params = [all ? 1 : 0, q, q, q, q, q, q, low ? 1 : 0, brand, brand];
    const limit = Math.min(Math.max(Number(query.get('limit')) || 1000, 1), 5000);
    // El total real va en un encabezado: la pantalla avisa si se muestran menos de los que hay.
    res.setHeader('X-Total-Count', db.prepare(`SELECT COUNT(*) AS n FROM articles a LEFT JOIN brands b ON b.id = a.brand_id ${where}`).get(...params).n);
    return maskCost(db.prepare(`
      ${ART} ${where}
      ORDER BY b.name, a.name, a.color,
        CASE a.size WHEN 'XXS' THEN 0 WHEN 'XS' THEN 1 WHEN 'S' THEN 2 WHEN 'M' THEN 3 WHEN 'L' THEN 4 WHEN 'XL' THEN 5 WHEN 'XXL' THEN 6 ELSE 9 END, a.size
      LIMIT ${limit}
    `).all(...params), can);
  });

  route('GET', '/api/articles/barcode/:code', ['articulos.ver', 'stock.ver'], ({ params, can }) => {
    const code = decodeURIComponent(params.code).trim();
    // Exacto; si no, sin distinguir mayúsculas (lectores con bloqueo de mayúsculas) y sin ceros iniciales (UPC-A 12 dígitos vs EAN-13).
    const find = (where, ...args) => db.prepare(`${ART} WHERE ${where} AND a.active = 1 LIMIT 2`).all(...args);
    let found = find('a.barcode = ?', code);
    if (!found.length) found = find('a.barcode = ? COLLATE NOCASE', code);
    if (!found.length && /^\d+$/.test(code)) found = find("ltrim(a.barcode, '0') = ltrim(?, '0') AND a.barcode GLOB '[0-9]*' AND ltrim(?, '0') != ''", code, code);
    const a = found.length === 1 || (found.length && found[0].barcode === code) ? found[0] : null;
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

  // Importar artículos desde una planilla (Excel o CSV)
  const importer = createImporter(db, { resolveBrand, moveStock, tx });
  const imp = (fn) => {
    try { return fn(); } catch (e) {
      if (e instanceof SheetFormatError) throw bad(e.message);
      if (e instanceof ImportError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  route('GET', '/api/import/template', 'articulos.editar', () => ({
    raw: importer.template(), filename: 'planilla-modelo-articulos.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  route('POST', '/api/import/preview', 'articulos.editar', ({ body, user }) => imp(() => importer.preview(user.id, body)));
  route('POST', '/api/import/start', 'articulos.editar', ({ body, user, can }) => imp(() => ({ status: 202, data: importer.start(user.id, body, { canCost: can('costos.ver') }) })));
  route('GET', '/api/import/:id', 'articulos.editar', ({ params }) => imp(() => importer.status(params.id)));

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
      SELECT m.*, a.name, a.size, a.color, b.name AS brand, u.name AS user_name FROM stock_movements m JOIN articles a ON a.id = m.article_id
      LEFT JOIN brands b ON b.id = a.brand_id LEFT JOIN users u ON u.id = m.user_id
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

  // Limpiar el stock completo. Es irreversible: la pantalla pide dos confirmaciones y acá se exige la palabra LIMPIAR.
  // Si hay carpeta de copias configurada, primero se hace una copia y, si falla, no se toca nada.
  route('GET', '/api/stock/clear/preview', 'stock.limpiar', () => {
    const sold = '(SELECT article_id FROM sale_items UNION SELECT article_id FROM layaway_items)';
    const r = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(active),0) AS active, COALESCE(SUM(CASE WHEN active = 1 THEN stock ELSE 0 END),0) AS units,
      COALESCE(SUM(CASE WHEN id IN ${sold} THEN 1 ELSE 0 END),0) AS with_sales FROM articles`).get();
    return { ...r, deletable: r.total - r.with_sales, backup: !!backups.dirOf() };
  });
  route('POST', '/api/stock/clear', 'stock.limpiar', ({ body, user }) => {
    if (importer.isRunning()) throw new HttpError(409, 'Hay una carga de Excel en curso. Esperá a que termine.');
    if (!['zero', 'delete'].includes(body.mode)) throw bad('Elegí qué querés hacer con el stock');
    if (db.prepare("SELECT 1 FROM layaways WHERE status='open'").get()) throw new HttpError(409, 'Hay apartados (señas) abiertos con mercadería reservada: completalos o cancelalos antes de limpiar el stock.');
    if (String(body.confirm ?? '').trim().toUpperCase() !== 'LIMPIAR') throw bad('Para confirmar, escribí la palabra LIMPIAR');
    let backup = false;
    if (backups.dirOf()) {
      try { backups.run('antes de limpiar el stock'); backup = true; }
      catch (e) { throw new HttpError(500, `No se limpió nada: no se pudo hacer la copia de seguridad previa (${e.message}). Revisá la pestaña Copias.`); }
    }
    return tx(db, () => {
      const sold = 'SELECT article_id FROM sale_items UNION SELECT article_id FROM layaway_items';
      const withStock = db.prepare('SELECT id, stock FROM articles WHERE stock <> 0').all();
      const units = withStock.reduce((s, a) => s + a.stock, 0);
      for (const a of withStock) moveStock(a.id, -a.stock, 'limpieza', null, user.id); // queda registrado en los movimientos
      if (body.mode === 'zero') return { mode: 'zero', zeroed: withStock.length, units, deleted: 0, deactivated: 0, backup };
      // Borrar: lo que nunca se vendió desaparece; lo que tiene ventas queda dado de baja para no perder el historial.
      db.prepare(`DELETE FROM stock_movements WHERE article_id NOT IN (${sold})`).run();
      const deleted = db.prepare(`DELETE FROM articles WHERE id NOT IN (${sold})`).run().changes;
      const deactivated = db.prepare(`UPDATE articles SET active = 0 WHERE active = 1`).run().changes;
      return { mode: 'delete', zeroed: withStock.length, units, deleted, deactivated, backup };
    });
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

  // Apartados (señas)
  function layawayDetail(id) {
    const l = db.prepare(`SELECT l.*, c.name AS customer_name, c.doc AS customer_doc, c.phone AS customer_phone, u.name AS user_name
      FROM layaways l JOIN customers c ON c.id = l.customer_id LEFT JOIN users u ON u.id = l.user_id WHERE l.id=?`).get(id);
    if (!l) return null;
    const items = db.prepare('SELECT article_id, name, qty, price FROM layaway_items WHERE layaway_id=?').all(id).map((i) => ({ ...i }));
    const payments = db.prepare('SELECT amount, method, created_at FROM layaway_payments WHERE layaway_id=? ORDER BY id').all(id).map((p) => ({ ...p }));
    const paid = round2(payments.reduce((sum, p) => sum + p.amount, 0));
    return { ...l, items, payments, paid, remaining: round2(l.total - paid), customer_balance: customerBalance(l.customer_id) };
  }
  // Cuando el pago se completa: se genera la venta (sale del stock, a los precios fijados) con las señas como pago ya cobrado.
  function completeLayaway(l, user, can) {
    const rows = db.prepare('SELECT method, SUM(amount) AS a FROM layaway_payments WHERE layaway_id=? GROUP BY method').all(l.id);
    const items = db.prepare('SELECT article_id, qty, price FROM layaway_items WHERE layaway_id=?').all(l.id);
    const sale = createSale({ items: items.map((i) => ({ article_id: i.article_id, qty: i.qty })), payments: [], customer_id: l.customer_id }, user, can, 0, {
      prepaid: rows.filter((r) => METHODS.includes(r.method)).map((r) => ({ method: r.method, amount: round2(r.a) })),
      prepaidAccount: round2(rows.filter((r) => r.method === 'cuenta').reduce((sum, r) => sum + r.a, 0)),
      locked: Object.fromEntries(items.map((i) => [i.article_id, i.price])), layawayId: l.id,
    }).data;
    db.prepare("UPDATE layaways SET status='completed', sale_id=?, closed_at=datetime('now','localtime') WHERE id=?").run(sale.id, l.id);
    return sale;
  }
  function addLayawayPayment(l, amount, method, user) {
    const session = requireSession();
    if (method === 'cuenta') {
      if (amount > customerBalance(l.customer_id)) throw bad('El cliente no tiene tanto saldo a favor');
      db.prepare('INSERT INTO account_movements (customer_id,amount,concept,user_id) VALUES (?,?,?,?)').run(l.customer_id, -amount, `Seña apartado #${l.id}`, user.id);
    } else {
      db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,user_id) VALUES (?,?,?,?,?,?)')
        .run(session.id, 'ingreso', method, amount, `Seña apartado #${l.id} · ${db.prepare('SELECT name FROM customers WHERE id=?').get(l.customer_id).name}`, user.id);
    }
    db.prepare('INSERT INTO layaway_payments (layaway_id,amount,method,user_id) VALUES (?,?,?,?)').run(l.id, amount, method, user.id);
  }
  const payParams = (body, remaining) => {
    const amount = round2(num(body.amount, 'Monto'));
    if (amount <= 0) throw bad('El monto debe ser mayor a 0');
    if (amount > remaining + 0.001) throw bad(`El apartado solo debe ${money(remaining)}: no se puede cobrar más`);
    const method = body.method || 'efectivo';
    if (![...METHODS, 'cuenta'].includes(method)) throw bad('Medio de pago inválido');
    return { amount, method };
  };
  route('GET', '/api/layaways', ['ventas.cobrar', 'clientes.ver'], ({ query }) => {
    const status = query.get('status') || 'open', customer = query.get('customer_id');
    return db.prepare(`SELECT id FROM layaways WHERE (? = 'all' OR status = ?) AND (? IS NULL OR customer_id = ?) ORDER BY id DESC LIMIT 200`)
      .all(status, status, customer, customer).map((r) => layawayDetail(r.id));
  });
  route('GET', '/api/layaways/:id', ['ventas.cobrar', 'clientes.ver'], ({ params }) => {
    const l = layawayDetail(params.id);
    if (!l) throw new HttpError(404, 'Apartado no encontrado');
    return l;
  });
  route('POST', '/api/layaways', 'ventas.cobrar', ({ body, user, can }) => tx(db, () => {
    requireSession();
    const customer = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(Number(body.customer_id) || 0);
    if (!customer) throw bad('Elegí el cliente que deja la seña');
    const asked = Array.isArray(body.items) ? body.items : [];
    if (!asked.length) throw bad('El apartado no tiene artículos');
    const merged = new Map();
    for (const it of asked) merged.set(Number(it.article_id), (merged.get(Number(it.article_id)) || 0) + num(it.qty, 'Cantidad', { min: 1, int: true }));
    let total = 0; const lines = [];
    for (const [id, qty] of merged) {
      const a = db.prepare(`${ART} WHERE a.id=? AND a.active=1`).get(id);
      if (!a) throw new HttpError(404, `Artículo ${id} no encontrado`);
      const free = a.stock - a.reserved;
      if (free < qty) throw new HttpError(409, `No hay stock libre de "${a.name}" ${a.size} para apartar (hay ${Math.max(free, 0)}${a.reserved ? `, ${a.reserved} ya apartado${a.reserved === 1 ? '' : 's'}` : ''})`);
      lines.push({ a, qty }); total += a.price * qty;
    }
    total = round2(total);
    const { amount, method } = payParams(body.deposit || {}, total);
    const { lastInsertRowid: id } = db.prepare('INSERT INTO layaways (customer_id,total,note,user_id) VALUES (?,?,?,?)')
      .run(customer.id, total, String(body.note ?? '').trim().slice(0, 200), user.id);
    for (const { a, qty } of lines) {
      db.prepare('INSERT INTO layaway_items (layaway_id,article_id,name,qty,price) VALUES (?,?,?,?,?)')
        .run(id, a.id, [a.brand, a.name, a.size, a.color].filter(Boolean).join(' · '), qty, a.price);
    }
    const l = db.prepare('SELECT * FROM layaways WHERE id=?').get(id);
    addLayawayPayment(l, amount, method, user);
    const sale = amount >= total - 0.001 ? completeLayaway(l, user, can) : null; // señó todo: se entrega ya
    return { status: 201, data: { ...layawayDetail(id), sale } };
  }));
  route('POST', '/api/layaways/:id/payment', 'ventas.cobrar', ({ params, body, user, can }) => tx(db, () => {
    const l = layawayDetail(params.id);
    if (!l) throw new HttpError(404, 'Apartado no encontrado');
    if (l.status !== 'open') throw new HttpError(409, 'Este apartado ya está cerrado');
    const { amount, method } = payParams(body, l.remaining);
    addLayawayPayment(l, amount, method, user);
    const sale = amount >= l.remaining - 0.001 ? completeLayaway(l, user, can) : null; // completó el pago: se entrega y sale del stock
    return { status: 201, data: { ...layawayDetail(l.id), sale } };
  }));
  // Cancelar: la mercadería se libera y se decide qué pasa con lo señado (devolverlo o dejarlo como saldo a favor).
  route('POST', '/api/layaways/:id/cancel', 'ventas.devolver', ({ params, body, user }) => tx(db, () => {
    const l = layawayDetail(params.id);
    if (!l) throw new HttpError(404, 'Apartado no encontrado');
    if (l.status !== 'open') throw new HttpError(409, 'Este apartado ya está cerrado');
    const refund = body.refund;
    if (refund !== 'credit' && !METHODS.includes(refund)) throw bad('Indicá qué se hace con la seña: devolverla o dejarla como saldo a favor');
    const cash = round2(l.payments.filter((p) => p.method !== 'cuenta').reduce((sum, p) => sum + p.amount, 0));
    const account = round2(l.paid - cash);
    let toAccount = account;
    if (cash > 0) {
      if (refund === 'credit') toAccount = round2(toAccount + cash);
      else {
        const session = requireSession();
        db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,user_id) VALUES (?,?,?,?,?,?)')
          .run(session.id, 'egreso', refund, cash, `Devolución de seña apartado #${l.id} · ${l.customer_name}`, user.id);
      }
    }
    if (toAccount > 0) {
      db.prepare('INSERT INTO account_movements (customer_id,amount,concept,user_id) VALUES (?,?,?,?)').run(l.customer_id, toAccount, `Seña del apartado #${l.id} (cancelado)`, user.id);
    }
    db.prepare("UPDATE layaways SET status='cancelled', cancel_note=?, closed_at=datetime('now','localtime') WHERE id=?")
      .run(refund === 'credit' ? 'Seña pasada a saldo a favor' : `Seña devuelta (${refund})`, l.id);
    return layawayDetail(l.id);
  }));

  // Descuento y recargo, cada uno por monto o por porcentaje (si hay monto, manda el monto).
  // El descuento va sobre el subtotal; el recargo, sobre lo que queda después del descuento.
  function computeTotals(subtotal, adj = {}) {
    const n = (v, label) => { const x = Number(v ?? 0); if (!Number.isFinite(x) || x < 0) throw bad(`${label} inválido`); return x; };
    const dPct = n(adj.discount_pct, 'Descuento'), dAmt = n(adj.discount_amount, 'Descuento');
    const sPct = n(adj.surcharge_pct, 'Recargo'), sAmt = n(adj.surcharge_amount, 'Recargo');
    if (dPct > 100) throw bad('Descuento inválido');
    if (sPct > 100) throw bad('Recargo inválido');
    const discount = dAmt > 0 ? round2(dAmt) : round2(subtotal * dPct / 100);
    if (discount > subtotal) throw bad('El descuento no puede superar el subtotal');
    const base = round2(subtotal - discount);
    const surcharge = sAmt > 0 ? round2(sAmt) : round2(base * sPct / 100);
    return { discount, surcharge, total: round2(base + surcharge) };
  }
  const cleanAdjust = (a = {}) => Object.fromEntries(['discount_pct', 'discount_amount', 'surcharge_pct', 'surcharge_amount'].map((k) => [k, Math.max(0, Number(a[k]) || 0)]));

  // Ventas en espera
  const MAX_HELD = 50;
  const heldRow = (h) => {
    let items = []; try { items = JSON.parse(h.items); } catch { /* vacío */ }
    const priced = items.map((i) => ({ qty: i.qty, a: db.prepare('SELECT price FROM articles WHERE id=? AND active=1').get(i.article_id) }));
    let adjust = { discount_pct: h.discount_pct }; try { if (h.adjust) adjust = JSON.parse(h.adjust); } catch { /* sin ajustes */ }
    let total = 0;
    try { total = computeTotals(round2(priced.reduce((s, i) => s + (i.a ? i.a.price * i.qty : 0), 0)), adjust).total; } catch { /* ajuste que ya no entra: se ve el subtotal */ total = round2(priced.reduce((s, i) => s + (i.a ? i.a.price * i.qty : 0), 0)); }
    return { id: h.id, label: h.label, customer_id: h.customer_id, customer_name: h.customer_name, discount_pct: h.discount_pct, user_name: h.user_name ?? null, created_at: h.created_at,
      units: items.reduce((s, i) => s + i.qty, 0), total };
  };
  route('GET', '/api/held', 'ventas.cobrar', () =>
    db.prepare('SELECT h.*, u.name AS user_name FROM held_sales h LEFT JOIN users u ON u.id=h.user_id ORDER BY h.id').all().map(heldRow));
  route('POST', '/api/held', 'ventas.cobrar', ({ body, user }) => tx(db, () => {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw bad('La venta no tiene artículos');
    const clean = items.map((i) => {
      const qty = num(i.qty, 'Cantidad', { min: 1, int: true });
      if (!db.prepare('SELECT 1 FROM articles WHERE id=? AND active=1').get(i.article_id)) throw new HttpError(404, `Artículo ${i.article_id} no encontrado`);
      return { article_id: Number(i.article_id), qty };
    });
    const adjust = cleanAdjust(body.adjust ?? { discount_pct: body.discount_pct });
    if (adjust.discount_pct > 100 || adjust.surcharge_pct > 100) throw bad('Descuento o recargo inválido');
    let customer = null;
    if (body.customer_id) { customer = db.prepare('SELECT id,name FROM customers WHERE id=? AND active=1').get(body.customer_id); if (!customer) throw new HttpError(404, 'Cliente no encontrado'); }
    if (body.replace_id) db.prepare('DELETE FROM held_sales WHERE id=?').run(body.replace_id); // se volvió a poner en espera una ya retomada
    if (db.prepare('SELECT COUNT(*) AS n FROM held_sales').get().n >= MAX_HELD) throw new HttpError(409, `Hay demasiadas ventas en espera (máximo ${MAX_HELD}). Cobrá o descartá alguna.`);
    const label = String(body.label ?? '').trim().slice(0, 60);
    const customerName = customer ? customer.name : String(body.customer_name ?? '').trim().slice(0, 120);
    const { lastInsertRowid: id } = db.prepare('INSERT INTO held_sales (user_id,label,customer_id,customer_name,discount_pct,items,adjust) VALUES (?,?,?,?,?,?,?)')
      .run(user.id, label, customer?.id ?? null, customerName, adjust.discount_pct, JSON.stringify(clean), JSON.stringify(adjust));
    return { status: 201, data: heldRow({ ...db.prepare('SELECT * FROM held_sales WHERE id=?').get(id) }) };
  }));
  // Retomar: devuelve el carrito con los precios y el stock de ahora (lo que ya no existe se avisa). No la borra: se borra al cobrarla o descartarla.
  route('GET', '/api/held/:id', 'ventas.cobrar', ({ params }) => {
    const h = db.prepare('SELECT * FROM held_sales WHERE id=?').get(params.id);
    if (!h) throw new HttpError(404, 'La venta en espera ya no existe (quizás ya se cobró)');
    const items = [], missing = [];
    for (const i of JSON.parse(h.items)) {
      const a = db.prepare(`${ART} WHERE a.id=? AND a.active=1`).get(i.article_id);
      if (a) items.push({ qty: i.qty, article: a }); else missing.push(i.article_id);
    }
    const customer = h.customer_id ? db.prepare(`${CUSTOMER_LIST} WHERE c.id=? AND c.active=1`).get(h.customer_id) : null;
    let adjust = { discount_pct: h.discount_pct }; try { if (h.adjust) adjust = JSON.parse(h.adjust); } catch { /* sin ajustes */ }
    return { id: h.id, label: h.label, discount_pct: h.discount_pct, adjust, customer_name: h.customer_name,
      customer: customer ? { id: customer.id, name: customer.name, doc: customer.doc, balance: round2(customer.balance) } : null, items, missing: missing.length };
  });
  route('DELETE', '/api/held/:id', 'ventas.cobrar', ({ params }) => {
    db.prepare('DELETE FROM held_sales WHERE id=?').run(params.id);
    return { ok: true };
  });

  // Clientes y cuenta corriente
  const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
  const customerBalance = (id) => round2(db.prepare('SELECT COALESCE(SUM(amount),0) AS b FROM account_movements WHERE customer_id=?').get(id).b);
  const CUSTOMER_LIST = `
    SELECT c.*, COALESCE((SELECT SUM(amount) FROM account_movements WHERE customer_id=c.id),0) AS balance,
      (SELECT COUNT(*) FROM sales WHERE customer_id=c.id AND voided=0) AS sales_count,
      COALESCE((SELECT SUM(total) FROM sales WHERE customer_id=c.id AND voided=0),0) - COALESCE((SELECT SUM(value) FROM returns WHERE customer_id=c.id),0) AS sales_total,
      (SELECT MAX(created_at) FROM sales WHERE customer_id=c.id AND voided=0) AS last_sale
    FROM customers c`;
  function customerFields(b, cur = {}) {
    const text = (k, max, label, required = false) => {
      const v = String(b[k] ?? cur[k] ?? '').trim();
      if (required && !v) throw bad(`${label} es obligatorio`);
      if (v.length > max) throw bad(`${label} no puede superar los ${max} caracteres`);
      return v;
    };
    return { name: text('name', 120, 'El nombre', true), doc: text('doc', 30, 'El documento'), phone: text('phone', 40, 'El teléfono'),
      email: text('email', 120, 'El correo'), note: text('note', 300, 'La nota') };
  }
  const dupDoc = (doc, exceptId = 0) => doc && db.prepare("SELECT name FROM customers WHERE doc=? AND active=1 AND id!=?").get(doc, exceptId);

  route('GET', '/api/customers', ['clientes.ver', 'ventas.cobrar'], ({ query }) => {
    const q = `%${(query.get('q') || '').trim()}%`;
    const all = query.get('all') === '1';
    return db.prepare(`${CUSTOMER_LIST} WHERE (? OR c.active=1) AND (c.name LIKE ? OR c.doc LIKE ? OR c.phone LIKE ?)
      ORDER BY c.name COLLATE NOCASE LIMIT ?`).all(all ? 1 : 0, q, q, q, Math.min(Number(query.get('limit')) || 300, 1000))
      .map((c) => ({ ...c, balance: round2(c.balance) }));
  });
  route('GET', '/api/customers/:id', 'clientes.ver', ({ params }) => {
    const c = db.prepare(`${CUSTOMER_LIST} WHERE c.id=?`).get(params.id);
    if (!c) throw new HttpError(404, 'Cliente no encontrado');
    const movements = db.prepare(`SELECT m.*, u.name AS user_name FROM account_movements m LEFT JOIN users u ON u.id=m.user_id
      WHERE m.customer_id=? ORDER BY m.id DESC LIMIT 100`).all(c.id);
    const sales = db.prepare(`SELECT s.id, s.created_at, s.total, s.voided, s.account_amount FROM sales s WHERE s.customer_id=? ORDER BY s.id DESC LIMIT 50`).all(c.id)
      .map((s) => ({ ...s, items: db.prepare('SELECT name,qty,price FROM sale_items WHERE sale_id=?').all(s.id) }));
    return { ...c, balance: round2(c.balance), movements, sales };
  });
  route('POST', '/api/customers', 'clientes.editar', ({ body }) => {
    const f = customerFields(body);
    const dup = dupDoc(f.doc);
    if (dup) throw new HttpError(409, `Ya hay un cliente con ese documento: ${dup.name}`);
    const { lastInsertRowid: id } = db.prepare('INSERT INTO customers (name,doc,phone,email,note) VALUES (?,?,?,?,?)').run(f.name, f.doc, f.phone, f.email, f.note);
    return { status: 201, data: db.prepare(`${CUSTOMER_LIST} WHERE c.id=?`).get(id) };
  });
  route('PUT', '/api/customers/:id', 'clientes.editar', ({ params, body }) => {
    const cur = db.prepare('SELECT * FROM customers WHERE id=?').get(params.id);
    if (!cur) throw new HttpError(404, 'Cliente no encontrado');
    const f = customerFields(body, cur);
    const active = body.active === undefined ? cur.active : (body.active ? 1 : 0);
    if (active) { const dup = dupDoc(f.doc, cur.id); if (dup) throw new HttpError(409, `Ya hay un cliente con ese documento: ${dup.name}`); }
    db.prepare('UPDATE customers SET name=?,doc=?,phone=?,email=?,note=?,active=? WHERE id=?').run(f.name, f.doc, f.phone, f.email, f.note, active, cur.id);
    return db.prepare(`${CUSTOMER_LIST} WHERE c.id=?`).get(cur.id);
  });
  // Entra plata a la caja y sube el saldo del cliente: una seña o adelanto (queda a favor) o el pago de una deuda.
  route('POST', '/api/customers/:id/payment', 'clientes.cuenta', ({ body, params, user }) => tx(db, () => {
    const c = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(params.id);
    if (!c) throw new HttpError(404, 'Cliente no encontrado');
    const session = requireSession();
    const amount = round2(num(body.amount, 'Monto'));
    if (amount <= 0) throw bad('El monto debe ser mayor a 0');
    const method = body.method || 'efectivo';
    if (!METHODS.includes(method)) throw bad('Medio de pago inválido');
    const concept = String(body.concept || 'Pago del cliente').trim().slice(0, 100) || 'Pago del cliente';
    db.prepare('INSERT INTO account_movements (customer_id,amount,concept,method,user_id) VALUES (?,?,?,?,?)').run(c.id, amount, concept, method, user.id);
    db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,user_id) VALUES (?,?,?,?,?,?)')
      .run(session.id, 'ingreso', method, amount, `${concept} · ${c.name}`, user.id);
    return { status: 201, data: { balance: customerBalance(c.id) } };
  }));
  // Se le devuelve plata al cliente de su saldo a favor (sale de la caja).
  route('POST', '/api/customers/:id/payout', 'clientes.cuenta', ({ body, params, user }) => tx(db, () => {
    const c = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(params.id);
    if (!c) throw new HttpError(404, 'Cliente no encontrado');
    const session = requireSession();
    const amount = round2(num(body.amount, 'Monto'));
    if (amount <= 0) throw bad('El monto debe ser mayor a 0');
    if (amount > customerBalance(c.id)) throw bad('El cliente no tiene tanto saldo a favor');
    const method = body.method || 'efectivo';
    if (!METHODS.includes(method)) throw bad('Medio de pago inválido');
    db.prepare('INSERT INTO account_movements (customer_id,amount,concept,method,user_id) VALUES (?,?,?,?,?)').run(c.id, -amount, 'Devolución de saldo', method, user.id);
    db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,user_id) VALUES (?,?,?,?,?,?)')
      .run(session.id, 'egreso', method, amount, `Devolución de saldo · ${c.name}`, user.id);
    return { status: 201, data: { balance: customerBalance(c.id) } };
  }));

  // Ventas
  // `exchange`: parte del total cubierta por mercadería devuelta (cambios).
  // `extra.prepaid`: señas ya cobradas [{method, amount}] (apartado que se completa); `extra.locked`: precios fijados {article_id: price}; `extra.layawayId`: su reserva no cuenta como stock ocupado.
  function createSale(body, user, can, exchange = 0, extra = {}) {
    const prepaid = extra.prepaid || [];
    const prepaidAcc = extra.prepaidAccount || 0; // parte de la seña pagada con saldo a favor (ya descontado de la cuenta)
    const prepaidTotal = round2(prepaid.reduce((s, p) => s + p.amount, 0) + prepaidAcc);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw bad('La venta no tiene artículos');
    const payments = (Array.isArray(body.payments) ? body.payments : []).map((p) => {
      if (!METHODS.includes(p.method)) throw bad('Medio de pago inválido');
      return { method: p.method, amount: num(p.amount, 'Monto de pago') };
    }).filter((p) => p.amount > 0);
    const accountAmount = round2(num(body.account_amount ?? 0, 'Monto de cuenta corriente'));
    if (!payments.length && accountAmount <= 0 && !exchange && !prepaidTotal) throw bad('Indicá el medio de pago');

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
        const mine = extra.layawayId ? (db.prepare("SELECT COALESCE(SUM(qty),0) AS q FROM layaway_items WHERE layaway_id=? AND article_id=?").get(extra.layawayId, id).q) : 0;
        const available = a.stock - (a.reserved - mine);
        if (available < qty) throw new HttpError(409, `Stock insuficiente de "${a.name}" ${a.size} (hay ${Math.max(available, 0)}${a.reserved - mine > 0 ? `, ${a.reserved - mine} apartado${a.reserved - mine === 1 ? '' : 's'} para otros clientes` : ''})`);
        if (extra.locked?.[id] !== undefined) a.price = extra.locked[id]; // precio fijado en el apartado
        lines.push({ a, qty });
        subtotal += a.price * qty;
      }
      subtotal = round2(subtotal);
      const { discount, surcharge, total } = computeTotals(subtotal, body);

      // Cuenta corriente: se descuenta del saldo a favor del cliente; dejarlo debiendo requiere un permiso aparte.
      let customer = null;
      if (body.customer_id) {
        customer = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(body.customer_id);
        if (!customer) throw new HttpError(404, 'Cliente no encontrado');
      }
      if (accountAmount > 0) {
        if (!customer) throw bad('Para usar la cuenta corriente elegí un cliente');
        if (accountAmount > total) throw bad('El monto de cuenta corriente supera el total de la venta');
        const balance = customerBalance(customer.id);
        if (accountAmount > Math.max(balance, 0) && !can('clientes.fiar')) {
          throw bad(balance > 0 ? `El saldo a favor del cliente es ${money(balance)}` : 'El cliente no tiene saldo a favor');
        }
      }
      const paid = round2(payments.reduce((s, p) => s + p.amount, 0) + accountAmount + exchange + prepaidTotal);
      if (paid < total) throw bad(`Falta cobrar ${round2(total - paid).toFixed(2)}`);
      let change = round2(paid - total);
      if (change > 0) {
        // El vuelto solo puede salir del efectivo recibido.
        const cash = payments.find((p) => p.method === 'efectivo');
        if (!cash || cash.amount < change) throw bad('El pago excede el total y no hay efectivo para dar vuelto');
        cash.amount = round2(cash.amount - change);
      }
      const finalPayments = payments.filter((p) => p.amount > 0);

      const customerName = customer ? customer.name : String(body.customer_name ?? '').trim().slice(0, 120);
      const customerDoc = customer ? customer.doc : String(body.customer_doc ?? '').trim().slice(0, 30);
      const { lastInsertRowid: saleId } = db.prepare(
        'INSERT INTO sales (session_id,subtotal,discount,surcharge,total,user_id,customer_name,customer_doc,customer_id,account_amount,exchange_amount,prepaid_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(session.id, subtotal, discount, surcharge, total, user.id, customerName, customerDoc, customer?.id ?? null, round2(accountAmount + prepaidAcc), exchange, prepaidTotal);
      if (accountAmount > 0) {
        db.prepare('INSERT INTO account_movements (customer_id,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?)')
          .run(customer.id, -accountAmount, `Venta #${saleId}`, saleId, user.id);
      }
      for (const { a, qty } of lines) {
        const label = [a.brand, a.name, a.size, a.color].filter(Boolean).join(' · ');
        db.prepare('INSERT INTO sale_items (sale_id,article_id,name,qty,price,cost,brand) VALUES (?,?,?,?,?,?,?)')
          .run(saleId, a.id, label, qty, a.price, a.cost, a.brand);
        moveStock(a.id, -qty, 'venta', saleId, user.id);
      }
      if (body.held_id) db.prepare('DELETE FROM held_sales WHERE id=?').run(body.held_id); // la venta en espera ya se cobró
      for (const p of prepaid) { // la plata ya entró a la caja el día de la seña: solo se registra con qué medio se pagó
        db.prepare('INSERT INTO sale_payments (sale_id,method,amount) VALUES (?,?,?)').run(saleId, p.method, p.amount);
      }
      for (const p of finalPayments) {
        db.prepare('INSERT INTO sale_payments (sale_id,method,amount) VALUES (?,?,?)').run(saleId, p.method, p.amount);
        db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?,?,?)')
          .run(session.id, 'ingreso', p.method, p.amount, `Venta #${saleId}`, saleId, user.id);
      }
      return { status: 201, data: { id: saleId, subtotal, discount, surcharge, total, change, account_amount: accountAmount, exchange_amount: exchange, prepaid_amount: prepaidTotal, payments: finalPayments } };
    });
  }
  route('POST', '/api/sales', 'ventas.cobrar', ({ body, user, can }) => createSale(body, user, can));

  route('GET', '/api/sales', ['ventas.cobrar', 'caja.ver'], ({ query }) => {
    const date = query.get('date') || new Date().toLocaleDateString('sv-SE');
    const sales = db.prepare(`SELECT s.*, u.name AS seller FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE date(s.created_at) = ? ORDER BY s.id DESC`).all(date);
    for (const s of sales) {
      s.items = db.prepare(`SELECT i.id, i.name, i.qty, i.price,
        COALESCE((SELECT SUM(qty) FROM return_items WHERE sale_item_id = i.id),0) AS returned FROM sale_items i WHERE i.sale_id=?`).all(s.id);
      s.payments = db.prepare('SELECT method,amount FROM sale_payments WHERE sale_id=?').all(s.id);
      s.returned_value = round2(db.prepare('SELECT COALESCE(SUM(value),0) AS v FROM returns WHERE sale_id=?').get(s.id).v);
    }
    return sales;
  });

  route('POST', '/api/sales/:id/void', 'ventas.anular', ({ params, user }) => tx(db, () => {
    const session = requireSession();
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(params.id);
    if (!sale) throw new HttpError(404, 'Venta no encontrada');
    if (sale.voided) throw new HttpError(409, 'La venta ya está anulada');
    if (db.prepare('SELECT 1 FROM returns WHERE sale_id=?').get(sale.id)) throw new HttpError(409, 'La venta tiene devoluciones: no se puede anular');
    if (sale.exchange_amount > 0) throw new HttpError(409, 'Esta venta es parte de un cambio: no se puede anular');
    db.prepare('UPDATE sales SET voided=1 WHERE id=?').run(sale.id);
    for (const it of db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(sale.id)) moveStock(it.article_id, it.qty, 'anulacion', sale.id, user.id);
    if (sale.account_amount > 0 && sale.customer_id) {
      db.prepare('INSERT INTO account_movements (customer_id,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?)')
        .run(sale.customer_id, sale.account_amount, `Anulación venta #${sale.id}`, sale.id, user.id);
    }
    // El reintegro sale de la caja abierta hoy, aunque la venta sea de una caja anterior.
    for (const p of db.prepare('SELECT * FROM sale_payments WHERE sale_id=?').all(sale.id)) {
      db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?,?,?)')
        .run(session.id, 'egreso', p.method, p.amount, `Anulación venta #${sale.id}`, sale.id, user.id);
    }
    return { ok: true };
  }));

  // Cambios y devoluciones
  const returnDetail = (r) => ({
    ...r,
    kind: r.new_sale_id ? 'cambio' : 'devolucion',
    items: db.prepare('SELECT name, qty, price FROM return_items WHERE return_id=?').all(r.id),
    new_items: r.new_sale_id ? db.prepare('SELECT name, qty, price FROM sale_items WHERE sale_id=?').all(r.new_sale_id) : [],
    new_sale: r.new_sale_id ? (() => {
      const n = db.prepare('SELECT * FROM sales WHERE id=?').get(r.new_sale_id);
      return { ...n, payments: db.prepare('SELECT method,amount FROM sale_payments WHERE sale_id=?').all(n.id) };
    })() : null,
  });
  route('GET', '/api/returns', ['ventas.cobrar', 'caja.ver'], ({ query }) => {
    const date = query.get('date') || new Date().toLocaleDateString('sv-SE');
    return db.prepare(`SELECT r.*, u.name AS user_name, s.customer_name, s.customer_doc, s.created_at AS sale_at FROM returns r
      JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.user_id WHERE date(r.created_at) = ? ORDER BY r.id DESC`).all(date).map(returnDetail);
  });
  route('POST', '/api/returns', 'ventas.devolver', ({ body, user, can }) => tx(db, () => {
    const session = requireSession();
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(Number(body.sale_id) || 0);
    if (!sale) throw new HttpError(404, 'Venta no encontrada');
    if (sale.voided) throw new HttpError(409, 'La venta está anulada');
    const asked = Array.isArray(body.items) ? body.items : [];
    if (!asked.length) throw bad('Elegí qué prendas se devuelven');

    // Cuánto se puede devolver de cada línea y a qué precio (el descuento de la venta se reparte en todas las prendas).
    // Si parte de la venta se pagó con mercadería devuelta (un cambio), eso no se vuelve a devolver en plata: solo lo realmente pagado.
    const paidTotal = round2(sale.total - sale.exchange_amount);
    const ratio = sale.subtotal ? paidTotal / sale.subtotal : 1;
    const lines = []; const seen = new Set();
    let value = 0;
    for (const it of asked) {
      const qty = num(it.qty, 'Cantidad', { min: 1, int: true });
      const si = db.prepare('SELECT * FROM sale_items WHERE id=? AND sale_id=?').get(it.sale_item_id, sale.id);
      if (!si) throw bad('Una de las prendas no pertenece a esa venta');
      if (seen.has(si.id)) throw bad('Una prenda está repetida');
      seen.add(si.id);
      const returned = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM return_items WHERE sale_item_id=?').get(si.id).q;
      if (qty > si.qty - returned) throw new HttpError(409, `De "${si.name}" solo se pueden devolver ${si.qty - returned} (ya se devolvieron ${returned})`);
      const unit = si.price * ratio;
      lines.push({ si, qty, unit });
      value += round2(qty * unit);
    }
    const already = db.prepare('SELECT COALESCE(SUM(value),0) AS v FROM returns WHERE sale_id=?').get(sale.id).v;
    value = Math.min(round2(value), round2(paidTotal - already)); // nunca más de lo que se pagó en la venta
    if (value <= 0) throw bad('No hay nada para devolver');

    // Cliente (para saldo a favor o cuenta corriente): el de la venta o el que se indique.
    const customerId = sale.customer_id || body.customer_id || null;
    const customer = customerId ? db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(customerId) : null;
    if (customerId && !customer) throw new HttpError(404, 'Cliente no encontrado');

    // 1) la mercadería vuelve al stock
    for (const l of lines) moveStock(l.si.article_id, l.qty, 'devolucion', sale.id, user.id);

    // 2) cambio: la prenda nueva se carga como una venta cubierta, en parte o del todo, por lo devuelto
    const wanted = Array.isArray(body.new_items) ? body.new_items : [];
    let exchange = 0, newSale = null;
    if (wanted.length) {
      const n = wanted.reduce((sum, it) => {
        const a = db.prepare('SELECT price FROM articles WHERE id=? AND active=1').get(it.article_id);
        if (!a) throw new HttpError(404, `Artículo ${it.article_id} no encontrado`);
        return sum + a.price * num(it.qty, 'Cantidad', { min: 1, int: true });
      }, 0);
      exchange = Math.min(value, round2(n));
      newSale = createSale({ items: wanted, payments: body.payments, account_amount: body.account_amount, customer_id: customer?.id }, user, can, exchange).data;
    }

    // 3) lo que sobra de lo devuelto: plata al cliente o saldo a favor
    const leftover = round2(value - exchange);
    let refundCash = 0, refundMethod = null, credit = 0;
    if (leftover > 0) {
      if (body.leftover === 'credit') {
        if (!customer) throw bad('Para dejar saldo a favor elegí un cliente');
        credit = leftover;
        db.prepare('INSERT INTO account_movements (customer_id,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?)')
          .run(customer.id, credit, `Saldo a favor por devolución (venta #${sale.id})`, sale.id, user.id);
      } else if (METHODS.includes(body.leftover)) {
        refundCash = leftover; refundMethod = body.leftover;
        db.prepare('INSERT INTO cash_movements (session_id,type,method,amount,concept,sale_id,user_id) VALUES (?,?,?,?,?,?,?)')
          .run(session.id, 'egreso', refundMethod, refundCash, `Devolución venta #${sale.id}`, sale.id, user.id);
      } else throw bad('Indicá cómo se le devuelve el dinero al cliente');
    }

    const { lastInsertRowid: id } = db.prepare(`INSERT INTO returns
      (sale_id,session_id,customer_id,new_sale_id,value,exchange_amount,refund_cash,refund_method,credit_amount,note,user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sale.id, session.id, customer?.id ?? null, newSale?.id ?? null, value, exchange, refundCash, refundMethod, credit, String(body.note ?? '').trim().slice(0, 200), user.id);
    for (const l of lines) {
      const full = db.prepare('SELECT cost, brand FROM sale_items WHERE id=?').get(l.si.id);
      db.prepare('INSERT INTO return_items (return_id,sale_item_id,article_id,name,qty,price,list_price,cost,brand) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, l.si.id, l.si.article_id, l.si.name, l.qty, round2(l.unit), l.si.price, full.cost, full.brand);
    }
    const r = db.prepare(`SELECT r.*, u.name AS user_name, s.customer_name, s.customer_doc, s.created_at AS sale_at FROM returns r
      JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id=?`).get(id);
    return { status: 201, data: returnDetail(r) };
  }));

  // Estadísticas
  const GROUPS = {
    day:   { fmt: '%Y-%m-%d', limit: 31 },
    week:  { fmt: '%Y-W%W',   limit: 12 },
    month: { fmt: '%Y-%m',    limit: 12 },
    year:  { fmt: '%Y',       limit: 10 },
  };

  // Las devoluciones restan en el período en que se hicieron (ventas, unidades y ganancia netas).
  const returnRows = (where, ...args) => db.prepare(`
    SELECT r.id, r.value, s.user_id AS seller_id, r.refund_cash, r.refund_method,
           COALESCE((SELECT SUM(qty) FROM return_items WHERE return_id=r.id),0) AS units,
           COALESCE((SELECT SUM(qty*cost) FROM return_items WHERE return_id=r.id),0) AS cost,
           strftime('%Y-%m-%d', r.created_at) AS day
    FROM returns r JOIN sales s ON s.id = r.sale_id WHERE ${where}`).all(...args);

  route('GET', '/api/stats/series', 'estadisticas.ver', ({ query, can }) => {
    const g = GROUPS[query.get('group') || 'day'];
    if (!g) throw bad('Agrupación inválida');
    const rows = db.prepare(`
      SELECT strftime('${g.fmt}', s.created_at) AS period,
             COUNT(*) AS sales, ROUND(SUM(s.total),2) AS total,
             COALESCE(SUM((SELECT SUM(qty) FROM sale_items WHERE sale_id = s.id)),0) AS units,
             ROUND(SUM(s.total - COALESCE((SELECT SUM(qty*cost) FROM sale_items WHERE sale_id = s.id),0)),2) AS profit
      FROM sales s WHERE s.voided = 0 GROUP BY period ORDER BY period DESC LIMIT ?`).all(g.limit).map((r) => ({ ...r }));
    const byPeriod = new Map(rows.map((r) => [r.period, r]));
    const rets = db.prepare(`
      SELECT strftime('${g.fmt}', r.created_at) AS period, ROUND(SUM(r.value),2) AS value,
             COALESCE(SUM((SELECT SUM(qty) FROM return_items WHERE return_id=r.id)),0) AS units,
             COALESCE(SUM((SELECT SUM(qty*cost) FROM return_items WHERE return_id=r.id)),0) AS cost
      FROM returns r GROUP BY period ORDER BY period DESC LIMIT ?`).all(g.limit);
    for (const r of rets) {
      const row = byPeriod.get(r.period) || { period: r.period, sales: 0, total: 0, units: 0, profit: 0 };
      if (!byPeriod.has(r.period)) { rows.push(row); byPeriod.set(r.period, row); }
      row.total = round2(row.total - r.value); row.units -= r.units; row.profit = round2(row.profit - (r.value - r.cost));
    }
    rows.sort((a, b) => (a.period < b.period ? 1 : -1));
    return rows.slice(0, g.limit).reverse().map((r) => ({ ...r, profit: can('costos.ver') ? r.profit : null, avg_ticket: r.sales ? round2(r.total / r.sales) : 0 }));
  });

  route('GET', '/api/stats/breakdown', 'estadisticas.ver', ({ query, can }) => {
    const g = GROUPS[query.get('group') || 'day'];
    if (!g) throw bad('Agrupación inválida');
    // Período actual según la agrupación elegida.
    const cur = db.prepare(`SELECT strftime('${g.fmt}','now','localtime') AS p`).get().p;
    const inPeriod = `strftime('${g.fmt}', s.created_at) = ? AND s.voided = 0`;
    const retIn = `strftime('${g.fmt}', r.created_at) = ?`;
    const rets = returnRows(retIn, cur);
    const retItems = db.prepare(`SELECT i.article_id, i.name, i.brand, i.qty, i.list_price, i.cost FROM return_items i JOIN returns r ON r.id = i.return_id WHERE ${retIn}`).all(cur);
    const totals = db.prepare(`SELECT COUNT(*) AS sales, COALESCE(ROUND(SUM(total),2),0) AS total FROM sales s WHERE ${inPeriod}`).get(cur);
    totals.total = round2(totals.total - rets.reduce((a, r) => a + r.value, 0));
    const byMethod = db.prepare(`
      SELECT p.method, ROUND(SUM(p.amount),2) AS total FROM sale_payments p JOIN sales s ON s.id = p.sale_id
      WHERE ${inPeriod} GROUP BY p.method`).all(cur).map((m) => ({ ...m }));
    for (const r of rets) if (r.refund_method && r.refund_cash) { // la plata devuelta resta del medio con que se devolvió
      const m = byMethod.find((x) => x.method === r.refund_method) || (byMethod.push({ method: r.refund_method, total: 0 }), byMethod.at(-1));
      m.total = round2(m.total - r.refund_cash);
    }
    const topArticles = db.prepare(`
      SELECT i.article_id, i.name, SUM(i.qty) AS units, ROUND(SUM(i.qty*i.price),2) AS total
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${inPeriod}
      GROUP BY i.article_id ORDER BY units DESC`).all(cur).map((a) => {
      const back = retItems.filter((x) => x.article_id === a.article_id);
      return { name: a.name, units: a.units - back.reduce((q, x) => q + x.qty, 0), total: round2(a.total - back.reduce((q, x) => q + x.qty * x.list_price, 0)) };
    }).filter((a) => a.units > 0).sort((x, y) => y.units - x.units).slice(0, 10);
    const bySeller = db.prepare(`
      SELECT COALESCE(u.name, 'Sin usuario') AS seller, COUNT(*) AS sales, ROUND(SUM(s.total),2) AS total
      FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE ${inPeriod} GROUP BY s.user_id`).all(cur).map((x) => ({ ...x }));
    for (const r of rets) { // lo devuelto resta al vendedor de la venta original
      const who = db.prepare('SELECT name FROM users WHERE id=?').get(r.seller_id)?.name ?? 'Sin usuario';
      const row = bySeller.find((x) => x.seller === who);
      if (row) row.total = round2(row.total - r.value);
    }
    bySeller.sort((x, y) => y.total - x.total);
    // A precio de lista (antes de descuentos), igual que «más vendidos». La ganancia solo con permiso de costos.
    const byBrand = db.prepare(`
      SELECT COALESCE(i.brand, 'Sin marca') AS brand, SUM(i.qty) AS units, ROUND(SUM(i.qty*i.price),2) AS total,
             ROUND(SUM(i.qty*(i.price-i.cost)),2) AS profit
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${inPeriod}
      GROUP BY COALESCE(i.brand, 'Sin marca')`).all(cur).map((r) => {
      const back = retItems.filter((x) => (x.brand || 'Sin marca') === r.brand);
      return {
        brand: r.brand, units: r.units - back.reduce((q, x) => q + x.qty, 0),
        total: round2(r.total - back.reduce((q, x) => q + x.qty * x.list_price, 0)),
        profit: can('costos.ver') ? round2(r.profit - back.reduce((q, x) => q + x.qty * (x.list_price - x.cost), 0)) : null,
      };
    }).sort((x, y) => y.total - x.total);
    return { period: cur, ...totals, byMethod, topArticles, bySeller, byBrand };
  });


  // ---------- Autenticación ----------
  const limiter = createLimiter();
  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role_name, hasPin: !!u.hasPin, permissions: u.permissions });

  function permsOf(role) {
    if (role.is_admin) return [...ALL_PERMISSIONS];
    try { return JSON.parse(role.permissions).filter((p) => ALL_PERMISSIONS.includes(p)); } catch { return []; }
  }

  // Usuario de la sesión actual (con sus permisos leídos en este momento, así un cambio de rol rige de inmediato).
  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.id, u.username, u.name, u.active, u.pin_hash IS NOT NULL AS has_pin, r.name AS role_name, r.permissions, r.is_admin,
             s.expires_at, s.token_hash, s.locked, s.last_seen, s.created_at AS started_at
      FROM user_sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = ?`).get(hashToken(token));
    if (!row || !row.active || row.expires_at < localNow()) return null;
    // Bloqueo por inactividad (si el administrador lo configuró) y registro de actividad.
    if (!row.locked) {
      const idleMin = Number(getSetting(db, 'idle_lock_minutes', '0'));
      const idleMs = Date.now() - new Date(String(row.last_seen || row.started_at).replace(' ', 'T')).getTime();
      if (idleMin > 0 && idleMs > idleMin * 60_000) {
        db.prepare('UPDATE user_sessions SET locked = 1 WHERE token_hash = ?').run(row.token_hash);
        row.locked = 1;
      } else if (idleMs > 20_000) {
        db.prepare('UPDATE user_sessions SET last_seen = ? WHERE token_hash = ?').run(localNow(), row.token_hash);
      }
    }
    return { ...row, locked: !!row.locked, hasPin: !!row.has_pin, permissions: permsOf(row) };
  }
  const localNow = (offsetHours = 0) => new Date(Date.now() + offsetHours * 3600_000).toLocaleString('sv-SE');

  function startSession(res, userId) {
    const token = newToken();
    db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(localNow());
    db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(hashToken(token), userId, localNow(SESSION_HOURS));
    // Con «pedir inicio de sesión al abrir» (por defecto) la cookie muere al cerrar el navegador; si no, dura el tiempo de la sesión.
    const persistent = getSetting(db, 'login_on_start', '1') === '0';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${persistent ? `; Max-Age=${SESSION_HOURS * 3600}` : ''}`);
  }
  const userFull = (id) => {
    const u = db.prepare('SELECT u.id,u.username,u.name,u.pin_hash IS NOT NULL AS has_pin,r.name AS role_name,r.permissions,r.is_admin FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?').get(id);
    return publicUser({ ...u, hasPin: !!u.has_pin, permissions: permsOf(u) });
  };
  const securityState = () => ({
    loginOnStart: getSetting(db, 'login_on_start', '1') !== '0',
    idleLockMinutes: Number(getSetting(db, 'idle_lock_minutes', '0')),
  });
  const waitText = (s) => (s >= 120 ? `${Math.ceil(s / 60)} minutos` : `${s} segundos`);
  // Contraseña o PIN. El PIN solo vale desde esta misma computadora (como el de Windows).
  function secretOk(userRow, secret, req) {
    const pwOk = verifyPassword(secret, userRow?.password_hash);
    const pinOk = PIN_RE.test(secret) && isLoopback(req.socket.remoteAddress) && verifyPassword(secret, userRow?.pin_hash);
    return pwOk || pinOk;
  }
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
    // Sesión bloqueada: solo se revela el nombre para la pantalla de desbloqueo.
    if (user?.locked) return { setupNeeded: false, version: appVersion(), user: null, locked: true, lockedName: user.name, permissions: PERMISSIONS };
    return { setupNeeded, version: appVersion(), dbFile, user: user ? publicUser(user) : null, security: user ? securityState() : undefined, permissions: PERMISSIONS };
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
    if (wait) throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${waitText(wait)}.`);
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!secretOk(u, String(body.password || ''), req)) {
      limiter.fail(key);
      throw new HttpError(401, 'Usuario o contraseña/PIN incorrectos');
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

  // Pantalla de bloqueo (como la de Windows): la sesión queda abierta pero hace falta PIN o contraseña para seguir.
  route('POST', '/api/auth/lock', null, ({ user }) => {
    db.prepare('UPDATE user_sessions SET locked = 1 WHERE token_hash = ?').run(user.token_hash);
    return { ok: true };
  });
  route('POST', '/api/auth/unlock', null, ({ body, user, req }) => {
    if (!user.locked) return { ok: true };
    const key = `${user.username.toLowerCase()}|${req.socket.remoteAddress}`;
    const wait = limiter.check(key);
    if (wait) throw new HttpError(429, `Demasiados intentos. Probá de nuevo en ${waitText(wait)}.`, { locked: true });
    const row = db.prepare('SELECT password_hash, pin_hash FROM users WHERE id = ?').get(user.id);
    if (!secretOk(row, String(body.secret || ''), req)) { limiter.fail(key); throw new HttpError(401, 'PIN o contraseña incorrectos', { locked: true }); }
    limiter.ok(key);
    db.prepare('UPDATE user_sessions SET locked = 0, last_seen = ? WHERE token_hash = ?').run(localNow(), user.token_hash);
    return { ok: true };
  });
  // El navegador avisa que hay actividad aunque no se hayan hecho pedidos, para no bloquear a quien está escribiendo.
  route('POST', '/api/auth/ping', null, () => ({ ok: true }));

  // PIN de acceso rápido: se pide la contraseña actual para ponerlo, cambiarlo o quitarlo.
  const confirmPassword = (userId, pw) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
    if (!verifyPassword(String(pw || ''), row.password_hash)) throw new HttpError(403, 'La contraseña actual no es correcta');
  };
  route('POST', '/api/auth/pin', null, ({ body, user }) => {
    confirmPassword(user.id, body.current);
    const pin = String(body.pin || '');
    if (!PIN_RE.test(pin)) throw bad('El PIN debe tener entre 4 y 8 números');
    if (isWeakPin(pin)) throw bad('Ese PIN es muy fácil de adivinar (como 0000 o 1234). Elegí otro.');
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPassword(pin), user.id);
    return { ok: true };
  });
  route('POST', '/api/auth/pin/remove', null, ({ body, user }) => {
    confirmPassword(user.id, body.current);
    db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ?').run(user.id);
    return { ok: true };
  });

  // Seguridad del programa (solo administradores).
  const IDLE_OPTIONS = [0, 1, 2, 5, 10, 15, 30, 60];
  route('GET', '/api/security', 'usuarios.admin', () => securityState());
  route('PUT', '/api/security', 'usuarios.admin', ({ body }) => {
    if (body.loginOnStart !== undefined) {
      if (typeof body.loginOnStart !== 'boolean') throw bad('Valor inválido');
      setSetting(db, 'login_on_start', body.loginOnStart ? '1' : '0');
    }
    if (body.idleLockMinutes !== undefined) {
      if (!IDLE_OPTIONS.includes(Number(body.idleLockMinutes))) throw bad('Tiempo de bloqueo inválido');
      setSetting(db, 'idle_lock_minutes', Number(body.idleLockMinutes));
    }
    return securityState();
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
    SELECT u.id,u.username,u.name,u.active,u.role_id,u.pin_hash IS NOT NULL AS has_pin,r.name AS role_name,u.created_at FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.active DESC, u.name`).all());

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
    if (body.clear_pin) db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ?').run(cur.id); // por si olvidó el PIN
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
    try { backups.configure({ dir: body.dir, auto: body.auto, pc_name: body.pc_name }); } catch (e) { throw bad(e.message); }
    return backups.status();
  });
  route('POST', '/api/backup/run', BACKUP, async () => {
    try { backups.run('manual'); } catch (e) { throw bad(e.message); }
    await gdrive.idle(); // si hay Drive conectado, el resultado de la subida ya figura en el estado
    return backups.status();
  });

  // Google Drive
  route('PUT', '/api/backup/google/credentials', BACKUP, ({ body }) => {
    try { gdrive.saveCredentials(body); } catch (e) { throw bad(e.message); }
    return backups.status();
  });
  route('POST', '/api/backup/google/start', BACKUP, ({ req }) => {
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw bad('Para conectar Google abrí el sistema desde esta computadora, en http://127.0.0.1:3000 (no desde otro equipo)');
    try { return { url: gdrive.authUrl(`http://${host}/api/backup/google/callback`) }; } catch (e) { throw bad(e.message); }
  });
  // Google vuelve acá con el navegador (sin cookie de sesión: la protege el "state" de un solo uso).
  route('GET', '/api/backup/google/callback', 'public', async ({ query }) => {
    const page = (ok, msg) => ({ html: `<!doctype html><meta charset="utf-8"><title>Liu Vi</title><meta http-equiv="refresh" content="${ok ? 2 : 6};url=/#copias">
      <body style="font:18px system-ui;max-width:520px;margin:15vh auto;padding:0 20px;text-align:center"><h2>${ok ? '✅' : '⚠️'} ${esc(msg)}</h2><p>Volviendo al sistema…</p></body>` });
    if (query.get('error')) return page(false, query.get('error') === 'access_denied' ? 'No diste el permiso: Google Drive no quedó conectado.' : `Google devolvió un error (${query.get('error')})`);
    try {
      await gdrive.finish(query.get('state') || '', query.get('code') || '');
      return page(true, 'Google Drive conectado');
    } catch (e) { return page(false, e.message); }
  });
  route('POST', '/api/backup/google/disconnect', BACKUP, async () => {
    await gdrive.disconnect();
    return backups.status();
  });

  // ---------- Despacho ----------
  const MAX_BODY = 34 * 1024 * 1024; // planillas de hasta ~25 MB (viajan en base64)
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, 'El archivo es demasiado grande (máximo 25 MB).');
      chunks.push(c);
    }
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
            if (user.locked && !LOCK_OK.has(url.pathname)) throw new HttpError(401, 'La sesión está bloqueada', { locked: true });
            if (r.perm && ![].concat(r.perm).some(can)) throw new HttpError(403, 'No tenés permiso para hacer esto');
          }
          // Defensa extra contra CSRF: las escrituras solo se aceptan como JSON (un form de otro sitio no puede enviarlo).
          if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) throw bad('Content-Type inválido');
          const body = req.method === 'GET' ? {} : await readBody(req);
          const out = await r.handler({ params, query: url.searchParams, body, user, can, req, res });
          if (out?.html) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
            return res.end(out.html);
          }
          if (out?.raw) {
            res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' });
            return res.end(out.raw);
          }
          return out && out.status && out.data !== undefined ? send(out.status, out.data) : send(200, out ?? null);
        }
        throw new HttpError(404, 'Ruta no encontrada');
      }
      // Archivos estáticos
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) { res.writeHead(404); return res.end('No encontrado'); }
      if (!statSync(file).isFile()) { res.writeHead(404); return res.end('No encontrado'); }
      const type = MIME[extname(file)] || 'application/octet-stream';
      let body = readFileSync(file);
      if (extname(file) === '.html') {
        // La página lleva su versión: los scripts y estilos se piden con ?v=VERSION, así una versión nueva nunca usa archivos viejos guardados por el navegador.
        const v = appVersion();
        body = Buffer.from(body.toString('utf8').replaceAll('__VERSION__', v).replace(/(src|href)="\/([\w.-]+\.(?:js|css))"/g, `$1="/$2?v=${v}"`));
      }
      // Código y página: el navegador siempre consulta si cambiaron (ETag, responde 304 si no). Imágenes: un día.
      const cache = type.startsWith('image/') ? 'public, max-age=86400' : 'no-cache';
      const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 24)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': cache }); return res.end(); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ETag: etag });
      res.end(body);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, ...e.extra });
      console.error(e);
      send(500, { error: 'Error interno' });
    }
  }
  handle.backups = backups;
  return handle;
}
