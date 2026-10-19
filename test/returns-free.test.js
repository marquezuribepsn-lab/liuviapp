import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from './helpers.js';
import { openDb } from '../db.js';

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
const ret = (t, body) => t.admin('POST', '/api/returns', body);

test('cambio sin ticket: la prenda que entra suma stock, la que se lleva descuenta y el crédito cubre el total (con descuento)', async () => {
  const t = await start();
  try {
    const { vestido, remera } = await escenario(t);
    // entra una remera acreditada a 9000; se lleva un vestido de 10000 con 10 % de descuento (9000): cambio parejo
    const r = await ret(t, { items: [{ article_id: remera.id, qty: 1, price: 9000 }], new_items: [{ article_id: vestido.id, qty: 1 }], discount_pct: 10 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.kind, 'cambio'); assert.equal(r.data.sale_id, null);
    assert.equal(r.data.value, 9000); assert.equal(r.data.exchange_amount, 9000); assert.equal(r.data.refund_cash, 0);
    assert.equal(r.data.new_sale.total, 9000); assert.equal(r.data.new_sale.exchange_amount, 9000);
    assert.equal(await stock(t, remera.id), 11);
    assert.equal(await stock(t, vestido.id), 9);
    assert.equal(await efectivo(t), 0, 'no entra ni sale plata');
    assert.equal(r.data.items[0].price, 9000);
  } finally { t.close(); }
});

test('cambio con diferencia: el cliente paga lo que falta; y si lo devuelto vale más, hay que decidir qué pasa con el resto', async () => {
  const t = await start();
  try {
    const { vestido, remera, top } = await escenario(t);
    const r = await ret(t, { items: [{ article_id: top.id, qty: 1, price: 5000 }], new_items: [{ article_id: vestido.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 5000 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.exchange_amount, 5000);
    assert.equal(await efectivo(t), 5000, 'paga la diferencia');
    // le falta pagar: no se registra nada (ni se mueve el stock)
    const poco = await ret(t, { items: [{ article_id: top.id, qty: 1, price: 5000 }], new_items: [{ article_id: vestido.id, qty: 1 }], payments: [{ method: 'efectivo', amount: 1000 }] });
    assert.equal(poco.status, 400); assert.match(poco.data.error, /Falta cobrar/);
    assert.equal(await stock(t, top.id), 11, 'solo cuenta el primer cambio');
    // entra una remera de 12000 y se lleva un top de 7000: sobran 5000 y hay que decir qué se hace
    const sin = await ret(t, { items: [{ article_id: remera.id, qty: 1 }], new_items: [{ article_id: top.id, qty: 1 }] });
    assert.equal(sin.status, 400); assert.match(sin.data.error, /cómo se le devuelve/);
    const con = await ret(t, { items: [{ article_id: remera.id, qty: 1 }], new_items: [{ article_id: top.id, qty: 1 }], leftover: 'efectivo' });
    assert.equal(con.status, 201);
    assert.equal(con.data.exchange_amount, 7000); assert.equal(con.data.refund_cash, 5000);
    assert.equal(await efectivo(t), 5000 - 5000);
  } finally { t.close(); }
});

test('devolución sin ticket: plata al cliente o saldo a favor, con permiso y validaciones', async () => {
  const t = await start();
  try {
    const { top, remera } = await escenario(t);
    const sinNada = await ret(t, { items: [] });
    assert.equal(sinNada.status, 400);
    const sinValor = await ret(t, { items: [{ article_id: top.id, qty: 1, price: 0 }], leftover: 'efectivo' });
    assert.equal(sinValor.status, 400); assert.match(sinValor.data.error, /cuánto vale/);
    const repetida = await ret(t, { items: [{ article_id: top.id, qty: 1 }, { article_id: top.id, qty: 1 }], leftover: 'efectivo' });
    assert.equal(repetida.status, 400);
    assert.equal((await ret(t, { items: [{ article_id: top.id, qty: 1 }] })).status, 400, 'hay que indicar cómo se devuelve el dinero');

    // reintegro en efectivo (precio actual por defecto)
    await t.admin('POST', '/api/cash/movement', { type: 'ingreso', method: 'efectivo', amount: 20000, concept: 'Fondo' });
    const r = await ret(t, { items: [{ article_id: top.id, qty: 2 }], leftover: 'efectivo', note: 'sin ticket' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.kind, 'devolucion'); assert.equal(r.data.value, 14000); assert.equal(r.data.refund_cash, 14000);
    assert.equal(await stock(t, top.id), 12);
    assert.equal(await efectivo(t), 20000 - 14000);

    // saldo a favor de una clienta
    const c = (await t.admin('POST', '/api/customers', { name: 'Ana Pérez' })).data;
    const cr = await ret(t, { items: [{ article_id: remera.id, qty: 1, price: 8000 }], leftover: 'credit', customer_id: c.id });
    assert.equal(cr.status, 201, JSON.stringify(cr.data));
    assert.equal(cr.data.credit_amount, 8000); assert.equal(cr.data.customer_name, 'Ana Pérez');
    assert.equal((await t.admin('GET', '/api/customers/' + c.id)).data.balance, 8000);
    const sinCliente = await ret(t, { items: [{ article_id: remera.id, qty: 1 }], leftover: 'credit' });
    assert.equal(sinCliente.status, 400);

    // aparece en «cambios y devoluciones del día» y en las estadísticas (restan en el período)
    const lista = (await t.admin('GET', '/api/returns')).data;
    assert.equal(lista.length, 2); assert.ok(lista.every((x) => x.sale_id === null));
    const serie = (await t.admin('GET', '/api/stats/series?group=day')).data.at(-1);
    assert.equal(serie.total, -(14000 + 8000)); assert.equal(serie.units, -3);
    const mov = (await t.admin('GET', '/api/stats/breakdown?group=day')).data;
    assert.equal(mov.total, -(14000 + 8000));
  } finally { t.close(); }
});

test('el cambio sin ticket respeta el permiso «cambios y devoluciones» y la caja abierta', async () => {
  const t = await start();
  try {
    const { top } = await escenario(t);
    const role = (await t.admin('POST', '/api/roles', { name: 'Cajero', permissions: ['ventas.cobrar'] })).data;
    await t.admin('POST', '/api/users', { username: 'cajero', name: 'Cajero', password: 'clave-segura-2', role_id: role.id });
    const c = t.client(); await c.call('POST', '/api/auth/login', { username: 'cajero', password: 'clave-segura-2' });
    assert.equal((await c.call('POST', '/api/returns', { items: [{ article_id: top.id, qty: 1 }], leftover: 'efectivo' })).status, 403);
    await t.admin('POST', '/api/cash/close', { counted: 0 });
    assert.equal((await ret(t, { items: [{ article_id: top.id, qty: 1 }], leftover: 'efectivo' })).status, 409, 'sin caja abierta no se registra');
    assert.equal(await stock(t, top.id), 10, 'y el stock no cambió');
  } finally { t.close(); }
});

test('un artículo que solo entró por devolución no rompe «limpiar stock» (borrar todo)', async () => {
  const t = await start();
  try {
    const { top } = await escenario(t);
    await t.admin('POST', '/api/cash/movement', { type: 'ingreso', method: 'efectivo', amount: 9000, concept: 'Fondo' });
    assert.equal((await ret(t, { items: [{ article_id: top.id, qty: 1 }], leftover: 'efectivo' })).status, 201);
    const r = await t.admin('POST', '/api/stock/clear', { mode: 'delete', confirm: 'LIMPIAR' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(t.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(t.db.prepare('SELECT 1 FROM articles WHERE id=?').get(top.id), 'el artículo con movimientos se conserva (de baja)');
  } finally { t.close(); }
});

test('migración: una base con devoluciones anteriores conserva todo y acepta devoluciones sin ticket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liuvi-mig-'));
  const file = join(dir, 'liuvi.db');
  try {
    const db = openDb(file);
    db.exec(`INSERT INTO articles (id,name,price,cost,stock) VALUES (1,'Vestido',10000,4000,5);
      INSERT INTO cash_sessions (id,opening_amount) VALUES (1,0);
      INSERT INTO sales (id,session_id,subtotal,discount,total) VALUES (1,1,10000,0,10000);
      INSERT INTO sale_items (id,sale_id,article_id,name,qty,price,cost) VALUES (1,1,1,'Vestido',1,10000,4000);`);
    // Estructura anterior: venta y línea de origen obligatorias.
    db.exec(`PRAGMA foreign_keys=OFF; BEGIN;
      DROP TABLE return_items; DROP TABLE returns;
      CREATE TABLE returns (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), session_id INTEGER NOT NULL REFERENCES cash_sessions(id), customer_id INTEGER REFERENCES customers(id), new_sale_id INTEGER REFERENCES sales(id), value REAL NOT NULL, exchange_amount REAL NOT NULL DEFAULT 0, refund_cash REAL NOT NULL DEFAULT 0, refund_method TEXT, credit_amount REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
      CREATE TABLE return_items (id INTEGER PRIMARY KEY, return_id INTEGER NOT NULL REFERENCES returns(id), sale_item_id INTEGER NOT NULL REFERENCES sale_items(id), article_id INTEGER NOT NULL REFERENCES articles(id), name TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), price REAL NOT NULL, list_price REAL NOT NULL, cost REAL NOT NULL DEFAULT 0, brand TEXT);
      INSERT INTO returns (id,sale_id,session_id,value,refund_cash,refund_method,note) VALUES (7,1,1,10000,10000,'efectivo','vieja');
      INSERT INTO return_items (id,return_id,sale_item_id,article_id,name,qty,price,list_price,cost,brand) VALUES (9,7,1,1,'Vestido',1,10000,10000,4000,'Koxis');
      COMMIT; PRAGMA foreign_keys=ON;`);
    db.close();

    const db2 = openDb(file); // al abrir se reconstruyen las tablas
    const nn = (t, c) => db2.prepare(`PRAGMA table_info(${t})`).all().find((x) => x.name === c).notnull;
    assert.equal(nn('returns', 'sale_id'), 0); assert.equal(nn('return_items', 'sale_item_id'), 0);
    assert.deepEqual({ ...db2.prepare('SELECT id,sale_id,value,note FROM returns').get() }, { id: 7, sale_id: 1, value: 10000, note: 'vieja' });
    assert.deepEqual({ ...db2.prepare('SELECT id,return_id,sale_item_id,qty,brand FROM return_items').get() }, { id: 9, return_id: 7, sale_item_id: 1, qty: 1, brand: 'Koxis' });
    db2.prepare("INSERT INTO returns (sale_id,session_id,value) VALUES (NULL,1,5)").run(); // sin ticket
    db2.prepare("INSERT INTO return_items (return_id,sale_item_id,article_id,name,qty,price,list_price) VALUES (?,NULL,1,'x',1,5,5)").run(db2.prepare('SELECT MAX(id) AS i FROM returns').get().i);
    assert.equal(db2.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(db2.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_returns_sale'").get(), 'se recrean los índices');
    db2.close();
    openDb(file).close(); // abrir otra vez no repite nada
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
