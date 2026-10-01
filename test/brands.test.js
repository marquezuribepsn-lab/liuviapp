import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('vienen cargadas Koxis, Adicta e Inversa', async () => {
  const t = await start();
  try {
    const brands = (await t.admin('GET', '/api/brands')).data;
    assert.deepEqual(brands.map((b) => b.name), ['Adicta', 'Inversa', 'Koxis']);
  } finally { t.close(); }
});

test('el artículo se asocia a la marca sin duplicarla y se puede filtrar y buscar', async () => {
  const t = await start();
  try {
    const a = (await t.admin('POST', '/api/articles', { barcode: '1', name: 'Remera', size: 'M', price: 1000, cost: 400, stock: 5, brand: 'koxis' })).data;
    assert.equal(a.brand, 'Koxis', 'respeta el nombre existente aunque se escriba en minúsculas');
    const b = (await t.admin('POST', '/api/articles', { barcode: '2', name: 'Vestido', price: 2000, stock: 1, brand: ' ADICTA ' })).data;
    assert.equal(b.brand, 'Adicta');
    await t.admin('POST', '/api/articles', { barcode: '3', name: 'Campera', price: 3000, stock: 1 });
    assert.equal((await t.admin('GET', '/api/brands')).data.length, 3, 'no se crearon marcas de más');

    // Una marca nueva se crea al vuelo
    await t.admin('POST', '/api/articles', { barcode: '4', name: 'Short', price: 500, stock: 1, brand: 'Nueva Marca' });
    assert.equal((await t.admin('GET', '/api/brands')).data.length, 4);

    const brands = (await t.admin('GET', '/api/brands')).data;
    const koxis = brands.find((x) => x.name === 'Koxis');
    assert.equal(koxis.articles, 1);
    assert.deepEqual((await t.admin('GET', `/api/articles?brand_id=${koxis.id}`)).data.map((x) => x.name), ['Remera']);
    assert.equal((await t.admin('GET', '/api/articles?q=adicta')).data[0].name, 'Vestido', 'la búsqueda también mira la marca');
    assert.equal((await t.admin('GET', '/api/articles/barcode/1')).data.brand, 'Koxis');

    // Editar: cambiar de marca, quitarla, o no tocarla
    assert.equal((await t.admin('PUT', `/api/articles/${a.id}`, { brand: 'Inversa' })).data.brand, 'Inversa');
    assert.equal((await t.admin('PUT', `/api/articles/${a.id}`, { price: 1200 })).data.brand, 'Inversa', 'si no se envía, se conserva');
    assert.equal((await t.admin('PUT', `/api/articles/${a.id}`, { brand: '' })).data.brand, null);
    assert.equal((await t.admin('POST', '/api/articles', { name: 'X', price: 1, brand: 'x'.repeat(41) })).status, 400);
  } finally { t.close(); }
});

test('administrar marcas: renombrar, borrar solo las sin artículos, y permisos', async () => {
  const t = await start();
  try {
    const [adicta, inversa, koxis] = (await t.admin('GET', '/api/brands')).data;
    await t.admin('POST', '/api/articles', { name: 'Remera', price: 1, stock: 1, brand: 'Koxis' });
    assert.equal((await t.admin('PUT', `/api/brands/${koxis.id}`, { name: 'KOXIS Jeans' })).status, 200);
    assert.equal((await t.admin('PUT', `/api/brands/${inversa.id}`, { name: 'koxis jeans' })).status, 400, 'nombre duplicado');
    assert.equal((await t.admin('POST', '/api/brands', { name: 'adicta' })).status, 400);
    assert.equal((await t.admin('DELETE', `/api/brands/${koxis.id}`)).status, 409, 'tiene artículos');
    assert.equal((await t.admin('DELETE', `/api/brands/${adicta.id}`)).status, 200);
    assert.equal((await t.admin('GET', '/api/articles')).data[0].brand, 'KOXIS Jeans', 'el artículo ve el nombre nuevo');

    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('GET', '/api/brands')).status, 200, 'el vendedor ve las marcas');
    for (const [m, p, b] of [['POST', '/api/brands', { name: 'Z' }], ['PUT', `/api/brands/${inversa.id}`, { name: 'Z' }], ['DELETE', `/api/brands/${inversa.id}`]]) {
      assert.equal((await ana.call(m, p, b)).status, 403, `${m} ${p}`);
    }
  } finally { t.close(); }
});

test('la venta guarda la marca y las estadísticas se agrupan por marca (ganancia solo con permiso)', async () => {
  const t = await start();
  try {
    const k = (await t.admin('POST', '/api/articles', { barcode: '1', name: 'Remera', size: 'M', price: 1000, cost: 400, stock: 10, brand: 'Koxis' })).data;
    const i = (await t.admin('POST', '/api/articles', { barcode: '2', name: 'Vestido', price: 5000, cost: 2000, stock: 10, brand: 'Inversa' })).data;
    const s = (await t.admin('POST', '/api/articles', { barcode: '3', name: 'Medias', price: 100, cost: 30, stock: 10 })).data;
    await t.admin('POST', '/api/cash/open', { amount: 0 });
    const sale = (await t.admin('POST', '/api/sales', {
      items: [{ article_id: k.id, qty: 3 }, { article_id: i.id, qty: 1 }, { article_id: s.id, qty: 2 }],
      payments: [{ method: 'efectivo', amount: 8200 }],
    })).data;
    const today = (await t.admin('GET', '/api/sales')).data.find((x) => x.id === sale.id);
    assert.deepEqual(today.items.map((x) => x.name), ['Koxis · Remera · M', 'Inversa · Vestido', 'Medias'], 'el detalle del ticket lleva la marca');

    const br = (await t.admin('GET', '/api/stats/breakdown?group=day')).data;
    assert.deepEqual(br.byBrand.map((x) => [x.brand, x.units, x.total, x.profit]), [
      ['Inversa', 1, 5000, 3000], ['Koxis', 3, 3000, 1800], ['Sin marca', 2, 200, 140],
    ]);

    // La marca queda congelada al momento de la venta: renombrarla no reescribe el pasado
    const brands = (await t.admin('GET', '/api/brands')).data;
    await t.admin('PUT', `/api/brands/${brands.find((b) => b.name === 'Koxis').id}`, { name: 'Koxis Jeans' });
    assert.ok((await t.admin('GET', '/api/stats/breakdown?group=day')).data.byBrand.some((x) => x.brand === 'Koxis'));

    // Sin costos.ver no hay ganancia por marca
    const rol = (await t.admin('POST', '/api/roles', { name: 'Analista', permissions: ['estadisticas.ver'] })).data;
    await t.admin('POST', '/api/users', { username: 'leo', name: 'Leo', password: 'clave-leo-1234', role_id: rol.id });
    const leo = t.client(); await leo.call('POST', '/api/auth/login', { username: 'leo', password: 'clave-leo-1234' });
    const lb = (await leo.call('GET', '/api/stats/breakdown?group=day')).data.byBrand;
    assert.ok(lb.length === 3 && lb.every((x) => x.profit === null));
  } finally { t.close(); }
});

test('una base creada antes de existir las marcas se actualiza sin perder datos', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../db.js');
  const path = join(mkdtempSync(join(tmpdir(), 'liuvi-mig-')), 'vieja.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE articles (id INTEGER PRIMARY KEY, barcode TEXT UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', price REAL NOT NULL, cost REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, min_stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE TABLE sale_items (id INTEGER PRIMARY KEY, sale_id INTEGER, article_id INTEGER, name TEXT, qty INTEGER, price REAL, cost REAL DEFAULT 0);
    INSERT INTO articles (name, price, stock) VALUES ('Remera vieja', 100, 7);`);
  old.close();
  const db = openDb(path);
  assert.equal(db.prepare('SELECT stock FROM articles').get().stock, 7);
  assert.equal(db.prepare('SELECT brand_id FROM articles').get().brand_id, null);
  assert.deepEqual(db.prepare('SELECT name FROM brands ORDER BY name').all().map((b) => b.name), ['Adicta', 'Inversa', 'Koxis']);
  db.close();
});
