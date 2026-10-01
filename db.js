import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = process.env.DB_PATH || 'data/liuvi.db') {
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

    CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_cashmov_session ON cash_movements(session_id);
    CREATE INDEX IF NOT EXISTS idx_stockmov_article ON stock_movements(article_id);
  `);
  return db;
}
