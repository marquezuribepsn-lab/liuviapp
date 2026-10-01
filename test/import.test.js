import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './helpers.js';
import { readSheet, buildXlsx, parseCsv, SheetFormatError } from '../xlsx.js';
import { parseArticleSheet, parseNumber, buildTemplate } from '../importer.js';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import '../public/barcode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (n) => readFileSync(join(ROOT, 'test', 'fixtures', n));
const EJEMPLO = readFileSync(join(ROOT, 'ejemplos', 'articulos-prueba-koxis-adicta-inversa.xlsx'));
const HEAD = ['Código de barras', 'Marca', 'Artículo', 'Categoría', 'Talle', 'Color', 'Precio', 'Costo', 'Stock', 'Stock mínimo'];
const sheet = (rows) => buildXlsx([{ name: 'Artículos', rows: [HEAD, ...rows] }]);

// ---------- Lector de planillas ----------
test('lee un .xlsx hecho por otra librería (openpyxl): título antes de los encabezados, números, textos y vacíos', () => {
  const { sheetName, rows } = readSheet(fixture('openpyxl.xlsx'), 'proveedor.xlsx');
  assert.equal(sheetName, 'Artículos', 'elige la hoja «Artículos» aunque no sea la primera');
  const byRow = Object.fromEntries(rows.map((r) => [r.n, r.cells]));
  assert.equal(byRow[3][0], 'Cód.');
  assert.equal(byRow[4][0], 2001000000012, 'código numérico');
  assert.equal(byRow[4][2], 'Camisa & Blusa "premium"', 'entidades XML');
  assert.equal(byRow[5][0], '0001234567890', 'los ceros a la izquierda de un texto se conservan');
  assert.equal(byRow[5][2], 'Jean\nmom');
});

test('lee el archivo de ejemplo de 300 artículos', () => {
  const { rows } = readSheet(EJEMPLO, 'ejemplo.xlsx');
  assert.equal(rows.length, 301);
  assert.deepEqual(rows[0].cells, HEAD);
  assert.equal(rows[1].cells[0], '2001000000012');
});

test('escribe un .xlsx que se vuelve a leer igual (acentos, &, <, comillas, saltos de línea, ceros)', () => {
  const buf = buildXlsx([{ name: 'Artículos', rows: [['Código', 'Nombre'], ['00123', 'Ñandú & <Co> "x"\nlínea 2'], [{ v: 12500.5, s: 0 }, '  espacios  ']] }]);
  const { rows } = readSheet(buf);
  assert.deepEqual(rows.map((r) => r.cells), [['Código', 'Nombre'], ['00123', 'Ñandú & <Co> "x"\nlínea 2'], [12500.5, '  espacios  ']]);
});

test('lee CSV (punto y coma, comillas, BOM) y archivos de Excel «ANSI»', () => {
  const { rows } = readSheet(fixture('punto-y-coma.csv'), 'a.csv');
  assert.deepEqual(rows.map((r) => r.cells), [['Código de barras', 'Marca', 'Artículo', 'Precio', 'Stock'], ['111', 'Koxis', 'Remera, básica', '12.500,50', '3'], ['222', 'Adicta', 'Short "jean"', '20000', '0']]);
  assert.deepEqual(parseCsv('a,b\n"x,1","y ""q"""\n').map((r) => r.cells), [['a', 'b'], ['x,1', 'y "q"']]);
  assert.deepEqual(parseCsv('a\tb\r\n1\t2').map((r) => r.cells), [['a', 'b'], ['1', '2']]);
  const ansi = Buffer.from('Artículo;Precio\nCamisón;100\n', 'latin1');
  assert.equal(readSheet(ansi, 'x.csv').rows[1].cells[0], 'Camisón', 'Windows-1252 con acentos');
});

test('rechaza con un mensaje claro lo que no es una planilla', () => {
  const err = (buf, name) => assert.throws(() => readSheet(buf, name), SheetFormatError);
  err(Buffer.alloc(0), 'a.xlsx');
  err(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]), 'viejo.xls');
  assert.throws(() => readSheet(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(10)]), 'a.xls'), /\.xls|contraseña/);
  err(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3]), 'foto.png');
  err(Buffer.from('hola mundo sin separadores'), 'nota.docx');
  err(Buffer.from('PK\x03\x04 esto está roto'), 'roto.xlsx');
  const sinLibro = buildXlsx([{ name: 'x', rows: [['a']] }]);
  err(sinLibro.subarray(0, sinLibro.length - 30), 'truncado.xlsx'); // ZIP cortado a la mitad
});

test('un ZIP que miente sobre su tamaño no agota la memoria («bomba» de compresión)', () => {
  const buf = buildXlsx([{ name: 'Artículos', rows: [['x'.repeat(70 * 1024 * 1024)]] }]); // 70 MB de XML honesto
  assert.throws(() => readSheet(buf), (e) => e instanceof SheetFormatError && /demasiado grande/.test(e.message));
  // Mismo archivo pero con el tamaño declarado adulterado: se corta igual al descomprimir
  const forged = Buffer.from(buf);
  for (let i = 0; i < forged.length - 46; i++) {
    if (forged.readUInt32LE(i) === 0x02014b50 && forged.toString('utf8', i + 46, i + 46 + 24) === 'xl/worksheets/sheet1.xml') forged.writeUInt32LE(100, i + 24);
  }
  assert.throws(() => readSheet(forged), (e) => e instanceof SheetFormatError);
});

// ---------- Reglas de la planilla ----------
test('números en formato argentino y de Excel', () => {
  const casos = [['12500', 12500], ['12500,50', 12500.5], ['12.500,50', 12500.5], ['$ 12.500', 12500], ['38.000', 38000], ['12.5', 12.5], ['1,250.75', 1250.75], ['1.234.567', 1234567], ['  7 ', 7], [3, 3], [0, 0], ['0', 0]];
  for (const [entrada, esperado] of casos) assert.equal(parseNumber(entrada), esperado, String(entrada));
  for (const malo of ['abc', '12a', '1,2,3x', '--5', true, {}]) assert.ok(Number.isNaN(parseNumber(malo)), String(malo));
  assert.equal(parseNumber(''), undefined); assert.equal(parseNumber(null), undefined); assert.equal(parseNumber('  '), undefined);
});

test('valida fila por fila: informa el número de fila y carga solo las correctas', () => {
  const p = parseArticleSheet(readSheet(fixture('openpyxl.xlsx'), 'x.xlsx').rows);
  assert.equal(p.headerRow, 3, 'encuentra los títulos aunque haya una fila de título arriba');
  assert.equal(p.totalRows, 8, 'las filas vacías no cuentan');
  assert.deepEqual(p.items.map((i) => i.n), [4, 5, 6, 8]);
  const [a, b, c] = p.items;
  assert.deepEqual(a, { n: 4, name: 'Camisa & Blusa "premium"', brand: 'Koxis', category: 'Camisas', size: 'M', color: 'Verde', barcode: '2001000000012', price: 12500.5, cost: 5000, stock: 8, min_stock: 2 });
  assert.equal(b.barcode, '0001234567890'); assert.equal(b.name, 'Jean mom', 'saltos de línea y espacios dobles se limpian');
  assert.equal(b.price, 38000.5); assert.equal(b.cost, 17000); assert.equal(b.stock, 4); assert.equal(b.size, '40'); assert.ok(!('min_stock' in b), 'vacío = sin dato');
  assert.equal(c.name, 'Vestido largo'); assert.ok(!('barcode' in c) && !('stock' in c));
  assert.deepEqual(p.errors.map((e) => e.row), [9, 10, 11, 12]);
  assert.match(p.errors[0].message, /ya está en la fila 8/);
  assert.match(p.errors[1].message, /falta el nombre/);
  assert.match(p.errors[2].message, /precio no es un número/);
  assert.match(p.errors[3].message, /stock tiene que ser un número entero/);
});

test('reconoce los títulos con otras palabras, acentos y mayúsculas; pide lo mínimo', () => {
  const rows = (cells) => cells.map((c, i) => ({ n: i + 1, cells: c }));
  const ok = parseArticleSheet(rows([['DESCRIPCIÓN', 'pvp', 'Existencia', 'EAN', 'Talla'], ['Remera', '10.000', 5, '123', 'M']]));
  assert.deepEqual(ok.items, [{ n: 2, name: 'Remera', price: 10000, stock: 5, barcode: '123', size: 'M' }]);
  assert.deepEqual(ok.columns.filter((c) => c.found).map((c) => c.key).sort(), ['barcode', 'name', 'price', 'size', 'stock']);
  assert.throws(() => parseArticleSheet(rows([['Nombre', 'Cantidad'], ['x', 1]])), /«Artículo» y «Precio»/, 'sin precio no se puede');
  assert.throws(() => parseArticleSheet(rows([['hola'], ['chau']])), SheetFormatError);
  // Sin código: se distingue por marca + nombre + talle + color
  const dup = parseArticleSheet(rows([['Artículo', 'Precio', 'Marca', 'Talle'], ['Remera', 1, 'Koxis', 'M'], ['remera', 1, 'KOXIS', 'm'], ['Remera', 1, 'Koxis', 'L']]));
  assert.equal(dup.items.length, 2); assert.match(dup.errors[0].message, /mismo artículo/);
  assert.equal(parseArticleSheet(rows([['Artículo', 'Precio', 'Código'], ['x', 1, 'ñ-1']])).errors.length, 1, 'códigos con caracteres que el lector no imprime se rechazan');
});

test('la planilla modelo se puede abrir y trae los títulos y las instrucciones', () => {
  const buf = buildTemplate();
  const { sheetName, rows } = readSheet(buf);
  assert.equal(sheetName, 'Artículos');
  assert.deepEqual(rows[0].cells, HEAD);
  const p = parseArticleSheet(rows);
  assert.equal(p.items.length, 0, 'vacía: no carga nada si se sube sin completar');
  assert.ok(p.columns.every((c) => c.found));
});

// ---------- Carga completa ----------
const b64 = (buf) => buf.toString('base64');
async function cargar(call, buf, { mode = 'skip', genCodes, filename = 'planilla.xlsx' } = {}) {
  const pv = await call('POST', '/api/import/preview', { filename, data: b64(buf) });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  const st = await call('POST', '/api/import/start', { token: pv.data.token, mode, genCodes });
  assert.equal(st.status, 202, JSON.stringify(st.data));
  let s;
  for (let i = 0; i < 600; i++) { s = (await call('GET', `/api/import/${st.data.id}`)).data; if (s.state !== 'running') break; await new Promise((r) => setTimeout(r, 10)); }
  return { preview: pv.data, final: s };
}

test('carga los 300 artículos de ejemplo (100 por marca) con avance, stock y movimientos', async () => {
  const t = await start();
  try {
    const pv = (await t.admin('POST', '/api/import/preview', { filename: 'ejemplo.xlsx', data: b64(EJEMPLO) })).data;
    assert.equal(pv.totalRows, 300); assert.equal(pv.validRows, 300); assert.equal(pv.newRows, 300); assert.equal(pv.existingRows, 0);
    assert.equal(pv.errorCount, 0); assert.deepEqual(pv.newBrands, [], 'las tres marcas ya existen'); assert.equal(pv.sheet, 'Artículos');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM articles').get().n, 0, 'el análisis no carga nada');

    const st = (await t.admin('POST', '/api/import/start', { token: pv.token, mode: 'skip' })).data;
    assert.equal(st.total, 300);
    const visto = new Set(); let s;
    for (let i = 0; i < 1000; i++) { s = (await t.admin('GET', `/api/import/${st.id}`)).data; visto.add(s.state); if (s.state !== 'running') break; }
    assert.equal(s.state, 'done'); assert.equal(s.done, 300); assert.equal(s.created, 300); assert.equal(s.updated, 0); assert.equal(s.errorCount, 0);
    assert.equal(s.message, 'Carga finalizada.');

    const porMarca = (await t.admin('GET', '/api/brands')).data.map((b) => [b.name, b.articles]);
    assert.deepEqual(porMarca, [['Adicta', 100], ['Inversa', 100], ['Koxis', 100]]);
    assert.equal((await t.admin('GET', '/api/stock/summary')).data.units, 2353, 'unidades = suma del Excel');
    assert.equal((await t.admin('GET', '/api/stock/summary')).data.low, 54, '24 sin stock + 30 con stock bajo');
    const mov = t.db.prepare("SELECT COUNT(*) n, MIN(user_id) u FROM stock_movements WHERE reason = 'inicial'").get();
    assert.equal(mov.n, 276, 'un movimiento «inicial» por cada artículo con stock'); assert.equal(mov.u, 1, 'a nombre de quien cargó');
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM articles WHERE barcode IS NULL").get().n, 0);
    const a = (await t.admin('GET', '/api/articles/barcode/KOX-0007')).data;
    assert.equal(a.brand, 'Koxis'); assert.ok(a.price > 0 && a.cost > 0);
  } finally { t.close(); }
});

test('una carga de 15.000 filas muestra avance real y no deja que arranque otra a la vez', async () => {
  const t = await start();
  try {
    const rows = Array.from({ length: 15000 }, (_, i) => [`C${i}`, 'Koxis', `Artículo ${i}`, 'Prueba', 'M', 'Negro', 1000 + i, 400, 5, 2]);
    const grande = sheet(rows), otro = sheet([['Z1', 'Koxis', 'Otro', '', '', '', 1, '', 1, '']]);
    const pv1 = (await t.admin('POST', '/api/import/preview', { filename: 'g.xlsx', data: b64(grande) })).data;
    const pv2 = (await t.admin('POST', '/api/import/preview', { filename: 'o.xlsx', data: b64(otro) })).data;
    assert.equal(pv1.validRows, 15000);
    const t0 = Date.now();
    const st = (await t.admin('POST', '/api/import/start', { token: pv1.token, mode: 'skip' })).data;
    const r2 = await t.admin('POST', '/api/import/start', { token: pv2.token, mode: 'skip' });
    assert.equal(r2.status, 409, 'una sola carga a la vez'); assert.match(r2.data.error, /en curso/);
    let s, intermedio = false, maxDone = 0;
    for (let i = 0; i < 3000; i++) {
      s = (await t.admin('GET', `/api/import/${st.id}`)).data;
      if (s.state === 'running' && s.done > 0 && s.done < s.total) intermedio = true;
      assert.ok(s.done >= maxDone, 'el avance nunca retrocede'); maxDone = s.done;
      if (s.state !== 'running') break;
    }
    assert.ok(intermedio, 'se vieron estados intermedios (el avance es real)');
    assert.equal(s.state, 'done'); assert.equal(s.created, 15000);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM articles').get().n, 15000);
    console.log(`    15.000 filas cargadas en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // Ya liberado, se puede cargar otra
    assert.equal((await t.admin('POST', '/api/import/start', { token: pv2.token, mode: 'skip' })).status, 202);
  } finally { t.close(); }
});

test('volver a cargar la planilla no duplica; los tres modos para lo que ya existe', async () => {
  const t = await start();
  try {
    const base = sheet([['A1', 'Koxis', 'Remera', 'Remeras', 'M', 'Negro', 1000, 400, 10, 2], ['A2', 'Koxis', 'Remera', 'Remeras', 'L', 'Negro', 1000, 400, 4, 2]]);
    assert.equal((await cargar(t.admin, base)).final.created, 2);

    // 1) Omitir: nada cambia
    const otra = sheet([['A1', 'Koxis', 'Remera', 'Remeras', 'M', 'Negro', 9999, 400, 50, 2], ['A3', 'Adicta', 'Short', '', '', '', 500, '', 3, '']]);
    const r1 = (await cargar(t.admin, otra, { mode: 'skip' })).final;
    assert.deepEqual([r1.created, r1.updated, r1.skipped], [1, 0, 1]);
    assert.equal(t.db.prepare("SELECT price, stock FROM articles WHERE barcode='A1'").get().price, 1000);

    // 2) Reemplazar: actualiza datos y deja el stock del archivo (con su movimiento de ajuste)
    const r2 = (await cargar(t.admin, otra, { mode: 'replace' })).final;
    assert.deepEqual([r2.created, r2.updated, r2.skipped], [0, 2, 0]);
    const a1 = t.db.prepare("SELECT id, price, stock FROM articles WHERE barcode='A1'").get();
    assert.deepEqual([a1.price, a1.stock], [9999, 50]);
    assert.deepEqual({ ...t.db.prepare("SELECT qty, reason FROM stock_movements WHERE article_id=? ORDER BY id DESC LIMIT 1").get(a1.id) }, { qty: 40, reason: 'ajuste' });

    // 3) Sumar: el stock del archivo se suma al que hay
    const r3 = (await cargar(t.admin, sheet([['A1', 'Koxis', 'Remera', '', '', '', 9999, '', 5, '']]), { mode: 'add' })).final;
    assert.equal(r3.updated, 1); assert.equal(t.db.prepare("SELECT stock FROM articles WHERE barcode='A1'").get().stock, 55);
    assert.deepEqual({ ...t.db.prepare("SELECT qty, reason FROM stock_movements WHERE article_id=? ORDER BY id DESC LIMIT 1").get(a1.id) }, { qty: 5, reason: 'compra' });

    // Celdas vacías al actualizar = «no cambiar» (categoría, talle y color no se borran)
    const kept = t.db.prepare("SELECT category, size, color, cost FROM articles WHERE barcode='A1'").get();
    assert.deepEqual({ ...kept }, { category: 'Remeras', size: 'M', color: 'Negro', cost: 400 });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM articles').get().n, 3, 'nunca se duplicó nada');

    // Un artículo dado de baja vuelve a estar activo si está en la planilla
    await t.admin('DELETE', `/api/articles/${a1.id}`);
    assert.equal(t.db.prepare('SELECT active FROM articles WHERE id=?').get(a1.id).active, 0);
    await cargar(t.admin, sheet([['A1', 'Koxis', 'Remera', '', '', '', 9999, '', '', '']]), { mode: 'replace' });
    assert.equal(t.db.prepare('SELECT active, stock FROM articles WHERE id=?').get(a1.id).active, 1);
    assert.equal(t.db.prepare('SELECT stock FROM articles WHERE id=?').get(a1.id).stock, 55, 'stock vacío en el archivo: no se toca');
  } finally { t.close(); }
});

test('sin código de barras: crea uno válido o lo deja vacío, y reconoce lo ya cargado por marca+nombre+talle+color', async () => {
  const t = await start();
  try {
    const rows = [['', 'Koxis', 'Remera', 'Remeras', 'M', 'Negro', 1000, '', 3, ''], ['', 'Koxis', 'Remera', 'Remeras', 'L', 'Negro', 1000, '', 3, ''], ['', 'Adicta', 'Remera', 'Remeras', 'M', 'Negro', 1200, '', 2, '']];
    const r1 = await cargar(t.admin, sheet(rows));
    assert.equal(r1.preview.noCodeRows, 3);
    assert.equal(r1.final.created, 3);
    const codes = t.db.prepare('SELECT barcode FROM articles').all().map((a) => a.barcode);
    assert.equal(new Set(codes).size, 3, 'códigos distintos'); assert.ok(codes.every((c) => /^200\d{10}$/.test(c) && globalThis.Barcode.ean13Valid(c)), 'EAN-13 con dígito verificador válido');
    // Mismo nombre/talle/color en otra marca no es el mismo artículo (por eso se crearon 3)
    const r2 = await cargar(t.admin, sheet(rows), { mode: 'skip' });
    assert.equal(r2.preview.existingRows, 3); assert.equal(r2.preview.newRows, 0);
    assert.deepEqual([r2.final.created, r2.final.skipped], [0, 3]);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM articles').get().n, 3);

    // Sin generar códigos queda vacío
    const r3 = await cargar(t.admin, sheet([['', 'Koxis', 'Pollera', '', 'M', '', 500, '', 1, '']]), { genCodes: false });
    assert.equal(r3.final.created, 1); assert.equal(t.db.prepare("SELECT barcode FROM articles WHERE name='Pollera'").get().barcode, null);
  } finally { t.close(); }
});

test('crea las marcas nuevas de la planilla sin duplicar las existentes aunque cambien las mayúsculas', async () => {
  const t = await start();
  try {
    const buf = sheet([['B1', 'koxis', 'Remera', '', '', '', 1, '', 1, ''], ['B2', 'Marca Nueva', 'Short', '', '', '', 1, '', 1, ''], ['B3', 'MARCA NUEVA', 'Top', '', '', '', 1, '', 1, '']]);
    const { preview, final } = await cargar(t.admin, buf);
    assert.deepEqual(preview.newBrands, ['Marca Nueva']);
    assert.equal(final.brandsCreated, 1);
    assert.deepEqual((await t.admin('GET', '/api/brands')).data.map((b) => b.name), ['Adicta', 'Inversa', 'Koxis', 'Marca Nueva']);
    assert.equal((await t.admin('GET', '/api/articles/barcode/B1')).data.brand, 'Koxis');
  } finally { t.close(); }
});

test('las filas con errores no se cargan pero se informan; el resto sí', async () => {
  const t = await start();
  try {
    const { preview, final } = await cargar(t.admin, fixture('openpyxl.xlsx'), { filename: 'proveedor.xlsx' });
    assert.equal(preview.errorCount, 4); assert.deepEqual(preview.errors.map((e) => e.row), [9, 10, 11, 12]);
    assert.deepEqual([final.created, final.errorCount, final.total], [4, 4, 4]);
    assert.equal(final.errors.length, 4);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM articles').get().n, 4);
  } finally { t.close(); }
});

test('también carga CSV', async () => {
  const t = await start();
  try {
    const { final } = await cargar(t.admin, fixture('punto-y-coma.csv'), { filename: 'mis-articulos.csv' });
    assert.equal(final.created, 2);
    assert.equal((await t.admin('GET', '/api/articles/barcode/111')).data.price, 12500.5);
  } finally { t.close(); }
});

test('permisos: solo quien puede editar artículos; sin «ver costos» no se cargan costos', async () => {
  const t = await start();
  try {
    const roles = (await t.admin('GET', '/api/roles')).data;
    const mk = async (u, role_id) => { await t.admin('POST', '/api/users', { username: u, name: u, password: 'clave-larga-1', role_id }); const c = t.client(); await c.call('POST', '/api/auth/login', { username: u, password: 'clave-larga-1' }); return c; };
    const ana = await mk('ana', roles.find((r) => r.name === 'Vendedor').id);
    const rol = (await t.admin('POST', '/api/roles', { name: 'Cargador', permissions: ['articulos.ver', 'articulos.editar'] })).data;
    const leo = await mk('leo', rol.id);

    for (const [m, p, b] of [['POST', '/api/import/preview', { data: 'x' }], ['POST', '/api/import/start', { token: 'x', mode: 'skip' }], ['GET', '/api/import/abc']]) {
      assert.equal((await ana.call(m, p, m === 'GET' ? undefined : b)).status, 403, `vendedor ${m} ${p}`);
    }
    assert.equal((await ana.raw('GET', '/api/import/template')).status, 403);
    assert.equal((await t.client().call('GET', '/api/import/abc')).status, 401, 'sin sesión');

    const { final } = await cargar(leo.call, sheet([['K1', 'Koxis', 'Remera', '', '', '', 1000, 700, 2, '']]));
    assert.equal(final.created, 1);
    assert.equal(t.db.prepare("SELECT cost FROM articles WHERE barcode='K1'").get().cost, 0, 'sin permiso de costos el costo del archivo se ignora');
    assert.equal(t.db.prepare("SELECT user_id FROM stock_movements WHERE reason='inicial'").get().user_id > 1, true, 'queda a nombre de quien cargó');
    // El administrador sí carga costos
    await cargar(t.admin, sheet([['K2', 'Koxis', 'Remera', '', '', '', 1000, 700, 2, '']]));
    assert.equal(t.db.prepare("SELECT cost FROM articles WHERE barcode='K2'").get().cost, 700);
  } finally { t.close(); }
});

test('errores del servidor: archivo inválido, análisis vencido o ajeno, modo inválido, cargas inexistentes', async () => {
  const t = await start();
  try {
    await t.admin('POST', '/api/users', { username: 'otro', name: 'Otro', password: 'clave-larga-1', role_id: (await t.admin('POST', '/api/roles', { name: 'Ed', permissions: ['articulos.editar'] })).data.id });
    assert.equal((await t.admin('POST', '/api/import/preview', {})).status, 400);
    const malo = await t.admin('POST', '/api/import/preview', { filename: 'foto.png', data: b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])) });
    assert.equal(malo.status, 400); assert.match(malo.data.error, /Formato no soportado/);
    const sinCols = await t.admin('POST', '/api/import/preview', { filename: 'x.csv', data: b64(Buffer.from('Nombre;Cantidad\nx;1')) });
    assert.match(sinCols.data.error, /«Artículo» y «Precio»/);

    assert.equal((await t.admin('POST', '/api/import/start', { token: 'inexistente', mode: 'skip' })).status, 404);
    const pv = (await t.admin('POST', '/api/import/preview', { filename: 'a.xlsx', data: b64(sheet([['A', 'Koxis', 'X', '', '', '', 1, '', 1, '']])) })).data;
    const otro = t.client(); await otro.call('POST', '/api/auth/login', { username: 'otro', password: 'clave-larga-1' });
    assert.equal((await otro.call('POST', '/api/import/start', { token: pv.token, mode: 'skip' })).status, 404, 'el análisis es de quien lo subió');
    assert.equal((await t.admin('POST', '/api/import/start', { token: pv.token, mode: 'borrar-todo' })).status, 400);
    assert.equal((await t.admin('POST', '/api/import/start', { token: pv.token, mode: 'skip' })).status, 202, 'tras un modo inválido el análisis sigue vigente');
    assert.equal((await t.admin('POST', '/api/import/start', { token: pv.token, mode: 'skip' })).status, 404, 'un análisis se usa una sola vez');
    assert.equal((await t.admin('GET', '/api/import/no-existe')).status, 404);

    const demasiadas = sheet(Array.from({ length: 20001 }, (_, i) => [`M${i}`, '', `x${i}`, '', '', '', 1, '', '', '']));
    const r = await t.admin('POST', '/api/import/preview', { filename: 'g.xlsx', data: b64(demasiadas) });
    assert.equal(r.status, 400); assert.match(r.data.error, /más de 20\.000 filas/);
  } finally { t.close(); }
});

test('un archivo de más de 25 MB se rechaza sin leerlo completo', async () => {
  const handle = createApp(openDb(':memory:'));
  const call = (opts) => new Promise((resolve) => {
    const req = Readable.from(opts.chunks);
    Object.assign(req, { method: 'POST', url: opts.url, headers: { 'content-type': 'application/json', ...(opts.cookie && { cookie: opts.cookie }) }, socket: { remoteAddress: '127.0.0.1' } });
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, writeHead: (s) => { res.status = s; }, end: (b) => resolve({ status: res.status, data: b ? JSON.parse(b) : null, headers }) };
    handle(req, res);
  });
  const setup = await call({ url: '/api/auth/setup', chunks: [Buffer.from(JSON.stringify({ username: 'marina', password: 'clave-segura-1' }))] });
  const cookie = setup.headers['set-cookie'].split(';')[0];
  const mb = Buffer.alloc(1024 * 1024, 97);
  const r = await call({ url: '/api/import/preview', cookie, chunks: Array.from({ length: 36 }, () => mb) });
  assert.equal(r.status, 413); assert.match(r.data.error, /máximo 25 MB/);
});

test('descarga de la planilla modelo y listado con total, límite y talles en orden', async () => {
  const t = await start();
  try {
    const d = await t.adminRaw('GET', '/api/import/template');
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.match(d.headers.get('content-disposition'), /planilla-modelo-articulos\.xlsx/);
    assert.deepEqual(readSheet(d.buffer).rows[0].cells, HEAD, 'el archivo descargado es una planilla válida');

    await cargar(t.admin, EJEMPLO);
    const l = await t.adminRaw('GET', '/api/articles?limit=10');
    assert.equal(l.headers.get('x-total-count'), '300', 'el total real viaja en un encabezado');
    assert.equal(JSON.parse(l.buffer).length, 10);
    assert.equal((await t.adminRaw('GET', '/api/articles?q=Koxis')).headers.get('x-total-count'), '100', 'el total respeta la búsqueda');
    const sizes = (await t.admin('GET', '/api/articles?q=Blazer')).data.filter((a) => a.brand === 'Koxis').map((a) => a.size);
    assert.deepEqual(sizes, ['S', 'M', 'L', 'XL', 'XXL'], 'S < M < L < XL < XXL en vez de orden alfabético');
  } finally { t.close(); }
});
