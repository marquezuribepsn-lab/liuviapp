import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLES } from './auth.js';

export const APP_DIR = dirname(fileURLToPath(import.meta.url));
export const appVersion = () => { try { return JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version; } catch { return '?'; } };

// ¿El programa está en una carpeta temporal o dentro de un ZIP sin extraer? (se pierde al cerrarlo)
export function looksTemporary(p = APP_DIR, tmp = tmpdir()) {
  const n = (x) => String(x).replaceAll('\\', '/').toLowerCase();
  return n(p).startsWith(n(tmp).replace(/\/$/, '') + '/') || /\/temp\//.test(n(p)) || /\.zip(\/|$)/.test(n(p));
}

export const getSetting = (db, key, def = '') => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? def;
export const setSetting = (db, key, value) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

// Al abrir el programa se pide iniciar sesión de nuevo (salvo que un administrador lo desactive):
// se cierran las sesiones que quedaron de la vez anterior.
export function clearSessionsIfRequired(db) {
  if (getSetting(db, 'login_on_start', '1') === '0') return false;
  db.exec('DELETE FROM user_sessions');
  return true;
}

// Resumen de lo guardado, para mostrarlo al iniciar y comprobar que los datos se conservan.
export function dataSummary(db) {
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return { users: n('users'), articles: n('articles'), sales: n('sales') };
}

// Carpeta fija de datos del usuario, FUERA de la carpeta del programa: así actualizar el programa
// (bajar un ZIP nuevo, extraerlo en otro lado) o abrirlo desde cualquier carpeta nunca deja la base vacía.
export function dataDirFor(platform = process.platform, env = process.env, home = homedir()) {
  if (env.LIUVI_DATA_DIR) return env.LIUVI_DATA_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'LiuVi');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'LiuVi');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'liuvi');
}
export const defaultDbPath = () => process.env.DB_PATH || join(dataDirFor(), 'liuvi.db');

// Versiones anteriores guardaban la base en <programa>/data/liuvi.db. Si existe y todavía no hay base
// en la carpeta nueva, se copia (copia consistente, sin tocar la original, que queda como respaldo).
export function migrateLegacyDb(legacy = join(APP_DIR, 'data', 'liuvi.db'), target = defaultDbPath()) {
  if (existsSync(target) || !existsSync(legacy)) return { migrated: false };
  mkdirSync(dirname(target), { recursive: true });
  const old = new DatabaseSync(legacy);
  try { old.prepare('VACUUM INTO ?').run(target); } finally { old.close(); }
  return { migrated: true, from: legacy, to: target };
}

// Permisos nuevos para roles creados antes de cada función (una sola vez por base). Se vuelve a correr al restaurar una copia vieja.
export function migrateRoles(db) {
  // Roles creados antes de existir los clientes: los que ya venden pueden buscar, crear y cobrar clientes (el administrador lo ajusta en Usuarios).
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr_clientes_v1'").get()) {
    const NEW = ['clientes.ver', 'clientes.editar', 'clientes.cuenta'];
    for (const r of db.prepare('SELECT id, permissions, is_admin FROM roles').all()) {
      let perms; try { perms = JSON.parse(r.permissions); } catch { continue; }
      if (r.is_admin || !perms.includes('ventas.cobrar')) continue;
      db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify([...new Set([...perms, ...NEW])]), r.id);
    }
    setSetting(db, 'migr_clientes_v1', '1');
  }
  // Idem para cambios y devoluciones: los roles que ya cobran pueden hacerlos.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='migr_devolver_v1'").get()) {
    for (const r of db.prepare('SELECT id, permissions, is_admin FROM roles').all()) {
      let perms; try { perms = JSON.parse(r.permissions); } catch { continue; }
      if (r.is_admin || !perms.includes('ventas.cobrar')) continue;
      db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify([...new Set([...perms, 'ventas.devolver'])]), r.id);
    }
    setSetting(db, 'migr_devolver_v1', '1');
  }
}

export function openDb(path = defaultDbPath()) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- Cada fila es un SKU: artículo + talle + color, con su propio código de barras y stock.
    CREATE TABLE IF NOT EXISTS articles (
      id         INTEGER PRIMARY KEY,
      barcode    TEXT UNIQUE,
      name       TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT '',
      size       TEXT NOT NULL DEFAULT '',
      color      TEXT NOT NULL DEFAULT '',
      price      REAL NOT NULL CHECK (price >= 0),
      cost       REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
      stock      INTEGER NOT NULL DEFAULT 0,
      min_stock  INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id          INTEGER PRIMARY KEY,
      article_id  INTEGER NOT NULL REFERENCES articles(id),
      qty         INTEGER NOT NULL,            -- positivo entra, negativo sale
      reason      TEXT NOT NULL,               -- compra, ajuste, venta, anulacion, inicial
      ref_sale_id INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id             INTEGER PRIMARY KEY,
      opened_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      opening_amount REAL NOT NULL DEFAULT 0,
      closed_at      TEXT,
      expected_cash  REAL,
      counted_cash   REAL,
      note           TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sales (
      id         INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
      subtotal   REAL NOT NULL,
      discount   REAL NOT NULL DEFAULT 0,
      total      REAL NOT NULL,
      voided     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id         INTEGER PRIMARY KEY,
      sale_id    INTEGER NOT NULL REFERENCES sales(id),
      article_id INTEGER NOT NULL REFERENCES articles(id),
      name       TEXT NOT NULL,                -- copia del nombre/talle al momento de vender
      qty        INTEGER NOT NULL CHECK (qty > 0),
      price      REAL NOT NULL,
      cost       REAL NOT NULL DEFAULT 0
    );

    -- Ingresos y egresos de caja. Las ventas generan un ingreso por cada medio de pago.
    CREATE TABLE IF NOT EXISTS cash_movements (
      id         INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
      type       TEXT NOT NULL CHECK (type IN ('ingreso','egreso')),
      method     TEXT NOT NULL CHECK (method IN ('efectivo','tarjeta','transferencia')),
      amount     REAL NOT NULL CHECK (amount > 0),
      concept    TEXT NOT NULL DEFAULT '',
      sale_id    INTEGER REFERENCES sales(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sale_payments (
      id      INTEGER PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      method  TEXT NOT NULL CHECK (method IN ('efectivo','tarjeta','transferencia')),
      amount  REAL NOT NULL CHECK (amount > 0)
    );

    -- Clientes y su cuenta corriente: el saldo es la suma de los movimientos (positivo = saldo a favor, negativo = debe).
    CREATE TABLE IF NOT EXISTS customers (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      doc        TEXT NOT NULL DEFAULT '',
      phone      TEXT NOT NULL DEFAULT '',
      email      TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS account_movements (
      id          INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      amount      REAL NOT NULL CHECK (amount != 0),
      concept     TEXT NOT NULL DEFAULT '',
      method      TEXT,
      sale_id     INTEGER REFERENCES sales(id),
      user_id     INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_account_customer ON account_movements(customer_id);

    -- Devoluciones y cambios. «value» es lo devuelto a precio pagado (con el descuento de la venta prorrateado).
    -- Ese valor se reparte en: exchange_amount (descontado de la compra nueva), refund_cash (plata devuelta) y credit_amount (saldo a favor).
    CREATE TABLE IF NOT EXISTS returns (
      id              INTEGER PRIMARY KEY,
      sale_id         INTEGER NOT NULL REFERENCES sales(id),
      session_id      INTEGER NOT NULL REFERENCES cash_sessions(id),
      customer_id     INTEGER REFERENCES customers(id),
      new_sale_id     INTEGER REFERENCES sales(id),
      value           REAL NOT NULL,
      exchange_amount REAL NOT NULL DEFAULT 0,
      refund_cash     REAL NOT NULL DEFAULT 0,
      refund_method   TEXT,
      credit_amount   REAL NOT NULL DEFAULT 0,
      note            TEXT NOT NULL DEFAULT '',
      user_id         INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS return_items (
      id           INTEGER PRIMARY KEY,
      return_id    INTEGER NOT NULL REFERENCES returns(id),
      sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
      article_id   INTEGER NOT NULL REFERENCES articles(id),
      name         TEXT NOT NULL,
      qty          INTEGER NOT NULL CHECK (qty > 0),
      price        REAL NOT NULL,       -- precio unitario efectivamente pagado
      list_price   REAL NOT NULL,       -- precio de lista (para las estadísticas, igual que las ventas)
      cost         REAL NOT NULL DEFAULT 0,
      brand        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns(sale_id);
    CREATE INDEX IF NOT EXISTS idx_returns_created ON returns(created_at);

    -- Ventas en espera: el carrito guardado (solo artículos y cantidades; precios y stock se leen al retomarla).
    CREATE TABLE IF NOT EXISTS held_sales (
      id            INTEGER PRIMARY KEY AUTOINCREMENT, -- los números no se reutilizan: un «cobrar» viejo nunca borra otra venta en espera
      user_id       INTEGER,
      label         TEXT NOT NULL DEFAULT '',
      customer_id   INTEGER REFERENCES customers(id),
      customer_name TEXT NOT NULL DEFAULT '',
      discount_pct  REAL NOT NULL DEFAULT 0,
      items         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Apartados (señas): la mercadería queda reservada a nombre del cliente hasta que complete el pago.
    -- Recién al completarse se genera la venta (y sale del stock). Las señas no pasan por la cuenta corriente.
    -- Proveedores y compras. El saldo de un proveedor es la suma de sus movimientos (positivo = se le debe, negativo = pagos).
    CREATE TABLE IF NOT EXISTS suppliers (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      phone      TEXT NOT NULL DEFAULT '',
      email      TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      invoice     TEXT NOT NULL DEFAULT '',
      bought_at   TEXT NOT NULL,
      total       REAL NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      user_id     INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS purchase_items (
      id          INTEGER PRIMARY KEY,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id),
      article_id  INTEGER NOT NULL REFERENCES articles(id),
      name        TEXT NOT NULL,
      qty         INTEGER NOT NULL CHECK (qty > 0),
      cost        REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplier_movements (
      id          INTEGER PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      amount      REAL NOT NULL CHECK (amount != 0),
      concept     TEXT NOT NULL DEFAULT '',
      method      TEXT,
      purchase_id INTEGER REFERENCES purchases(id),
      from_cash   INTEGER NOT NULL DEFAULT 0,
      user_id     INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_mov ON supplier_movements(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_article ON purchase_items(article_id);

    -- Cambios masivos de precios: cada tanda se puede deshacer (guarda los valores anteriores).
    CREATE TABLE IF NOT EXISTS price_batches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      count       INTEGER NOT NULL,
      user_id     INTEGER,
      undone      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      undone_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS price_changes (
      id         INTEGER PRIMARY KEY,
      batch_id   INTEGER NOT NULL REFERENCES price_batches(id),
      article_id INTEGER NOT NULL REFERENCES articles(id),
      old_price  REAL NOT NULL,
      new_price  REAL NOT NULL,
      old_cost   REAL NOT NULL,
      new_cost   REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_price_changes_batch ON price_changes(batch_id);

    CREATE TABLE IF NOT EXISTS layaways (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
      total       REAL NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      user_id     INTEGER,
      sale_id     INTEGER REFERENCES sales(id),
      cancel_note TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      closed_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS layaway_items (
      id         INTEGER PRIMARY KEY,
      layaway_id INTEGER NOT NULL REFERENCES layaways(id),
      article_id INTEGER NOT NULL REFERENCES articles(id),
      name       TEXT NOT NULL,
      qty        INTEGER NOT NULL CHECK (qty > 0),
      price      REAL NOT NULL            -- el precio queda fijo desde el día de la seña
    );
    CREATE TABLE IF NOT EXISTS layaway_payments (
      id         INTEGER PRIMARY KEY,
      layaway_id INTEGER NOT NULL REFERENCES layaways(id),
      amount     REAL NOT NULL CHECK (amount > 0),
      method     TEXT NOT NULL,           -- efectivo | tarjeta | transferencia | cuenta (saldo a favor del cliente)
      user_id    INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_layaway_items_article ON layaway_items(article_id);
    CREATE INDEX IF NOT EXISTS idx_layaway_status ON layaways(status);

    CREATE TABLE IF NOT EXISTS brands (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      permissions TEXT NOT NULL DEFAULT '[]',   -- JSON con la lista de permisos
      is_admin    INTEGER NOT NULL DEFAULT 0    -- rol protegido: siempre tiene todos los permisos
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role_id       INTEGER NOT NULL REFERENCES roles(id),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_cashmov_session ON cash_movements(session_id);
    CREATE INDEX IF NOT EXISTS idx_stockmov_article ON stock_movements(article_id);
  `);

  // Quién hizo cada operación. ALTER para bases creadas antes de existir los usuarios.
  const ensureColumn = (table, col, type = 'INTEGER') => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  ensureColumn('sales', 'user_id');
  ensureColumn('sales', 'customer_name');
  ensureColumn('sales', 'customer_doc');
  ensureColumn('sales', 'customer_id');
  ensureColumn('sales', 'surcharge', 'REAL NOT NULL DEFAULT 0'); // recargo (por ejemplo, costo de la tarjeta)
  ensureColumn('held_sales', 'adjust', "TEXT NOT NULL DEFAULT ''"); // descuento y recargo de la venta en espera (JSON)
  ensureColumn('sales', 'prepaid_amount', 'REAL NOT NULL DEFAULT 0'); // parte de la venta ya cobrada como seña de un apartado
  ensureColumn('sales', 'exchange_amount', 'REAL NOT NULL DEFAULT 0'); // parte de la venta cubierta por mercadería devuelta (cambio)
  ensureColumn('sales', 'account_amount', 'REAL NOT NULL DEFAULT 0'); // parte de la venta pagada con la cuenta del cliente
  ensureColumn('cash_movements', 'user_id');
  ensureColumn('stock_movements', 'user_id');
  ensureColumn('cash_sessions', 'opened_by');
  ensureColumn('cash_sessions', 'closed_by');
  ensureColumn('users', 'pin_hash', 'TEXT');                       // PIN de acceso rápido (cifrado)
  ensureColumn('user_sessions', 'locked', 'INTEGER DEFAULT 0');    // sesión bloqueada (pantalla de bloqueo)
  ensureColumn('user_sessions', 'last_seen', 'TEXT');              // última actividad, para el bloqueo por inactividad
  ensureColumn('articles', 'brand_id');
  ensureColumn('purchases', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('purchases', 'voided_at', 'TEXT');
  ensureColumn('purchases', 'edited_at', 'TEXT');
  ensureColumn('sale_items', 'brand', 'TEXT'); // marca al momento de vender, para las estadísticas por marca

  // Marcas que maneja el local (se pueden agregar, renombrar y borrar desde Artículos).
  if (!db.prepare('SELECT 1 FROM brands LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO brands (name) VALUES (?)');
    for (const b of ['Koxis', 'Adicta', 'Inversa']) ins.run(b);
  }

  if (!db.prepare('SELECT 1 FROM roles LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO roles (name, permissions, is_admin) VALUES (?,?,?)');
    for (const r of DEFAULT_ROLES) ins.run(r.name, JSON.stringify(r.permissions), r.is_admin);
  }
  migrateRoles(db);
  return db;
}
