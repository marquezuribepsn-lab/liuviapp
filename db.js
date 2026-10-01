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

    CREATE TABLE IF NOT EXISTS brands (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
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
  ensureColumn('cash_movements', 'user_id');
  ensureColumn('stock_movements', 'user_id');
  ensureColumn('cash_sessions', 'opened_by');
  ensureColumn('cash_sessions', 'closed_by');
  ensureColumn('articles', 'brand_id');
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
  return db;
}
