import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from './helpers.js';
import { buildXlsx } from '../xlsx.js';
import { PERMISSIONS } from '../auth.js';

const HEAD = ['Código de barras', 'Marca', 'Artículo', 'Categoría', 'Talle', 'Color', 'Precio', 'Costo', 'Stock', 'Stock mínimo'];
const PREV = '/api/stock/clear/preview', CLEAR = '/api/stock/clear';
const mk = async (t, c, over = {}) => (await t.admin('POST', '/api/articles', { name: 'Art', price: 1000, cost: 400, stock: 5, ...over })).data;

// Tres artículos: Remera (con ventas), Short y Top (nunca vendidos)
async function escenario(t) {
  const remera = await mk(t, null, { barcode: 'R1', name: 'Remera', brand: 'Koxis', stock: 10 });
  await mk(t, null, { barcode: 'S1', name: 'Short', brand: 'Adicta', stock: 4 });
  await mk(t, null, { barcode: 'T1', name: 'Top', brand: 'Inversa', stock: 0 });
  await t.admin('POST', '/api/cash/open', { amount: 0 });
  assert.equal((await t.admin('POST', '/api/sales', { items: [{ article_id: remera.id, qty: 2 }], payments: [{ method: 'efectivo', amount: 2000 }] })).status, 201);
  return remera;
}

test('permiso propio: lo tienen los administradores y no el vendedor', async () => {
  const t = await start();
  try {
    assert.ok(PERMISSIONS.some((p) => p.key === 'stock.limpiar'));
    const me = (await t.admin('GET', '/api/auth/me')).data;
    assert.ok(me.user.permissions.includes('stock.limpiar'));
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('GET', PREV)).status, 403);
    assert.equal((await ana.call('POST', CLEAR, { mode: 'zero', confirm: 'LIMPIAR' })).status, 403);
    // Un rol con solo ese permiso puede (el administrador lo reparte)
    const rol = (await t.admin('POST', '/api/roles', { name: 'Depósito', permissions: ['stock.limpiar'] })).data;
    await t.admin('POST', '/api/users', { username: 'leo', name: 'Leo', password: 'clave-leo-1234', role_id: rol.id });
    const leo = t.client(); await leo.call('POST', '/api/auth/login', { username: 'leo', password: 'clave-leo-1234' });
    assert.equal((await leo.call('GET', PREV)).status, 200);
  } finally { t.close(); }
});

test('hace falta la palabra LIMPIAR y un modo válido; sin eso no se toca nada', async () => {
  const t = await start();
  try {
    await escenario(t);
    const units = () => t.db.prepare('SELECT SUM(stock) s FROM articles').get().s;
    const antes = units();
    for (const body of [{}, { mode: 'zero' }, { mode: 'zero', confirm: 'si' }, { mode: 'zero', confirm: 'limpiar todo' }, { mode: 'borrar', confirm: 'LIMPIAR' }, { confirm: 'LIMPIAR' }]) {
      assert.equal((await t.admin('POST', CLEAR, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(units(), antes, 'nada cambió');
    assert.equal((await t.admin('POST', CLEAR, { mode: 'zero', confirm: ' limpiar ' })).status, 200, 'mayúsculas y espacios no importan');
  } finally { t.close(); }
});

test('vista previa: cuántos artículos, unidades y cuántos tienen ventas', async () => {
  const t = await start();
  try {
    assert.deepEqual({ ...(await t.admin('GET', PREV)).data }, { total: 0, active: 0, units: 0, with_sales: 0, deletable: 0, backup: false });
    await escenario(t);
    assert.deepEqual({ ...(await t.admin('GET', PREV)).data }, { total: 3, active: 3, units: 12, with_sales: 1, deletable: 2, backup: false });
  } finally { t.close(); }
});

test('modo «dejar en 0»: los artículos se conservan, el stock queda en 0 y se registra cada movimiento', async () => {
  const t = await start();
  try {
    const remera = await escenario(t); // Remera 8 (10-2), Short 4, Top 0
    const r = (await t.admin('POST', CLEAR, { mode: 'zero', confirm: 'LIMPIAR' })).data;
    assert.deepEqual({ ...r }, { mode: 'zero', zeroed: 2, units: 12, deleted: 0, deactivated: 0, backup: false });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM articles WHERE active = 1').get().n, 3, 'ninguno se borra');
    assert.equal(t.db.prepare('SELECT SUM(stock) s FROM articles').get().s, 0);
    const movs = t.db.prepare("SELECT article_id, qty, user_id FROM stock_movements WHERE reason = 'limpieza' ORDER BY qty").all();
    assert.deepEqual(movs.map((m) => m.qty), [-8, -4], 'un movimiento por cada artículo con stock');
    assert.ok(movs.every((m) => m.user_id === 1), 'a nombre de quien limpió');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sales').get().n, 1, 'las ventas no se tocan');
    assert.equal((await t.admin('GET', '/api/articles')).data.length, 3);
    assert.equal((await t.admin('POST', CLEAR, { mode: 'zero', confirm: 'LIMPIAR' })).data.zeroed, 0, 'repetirlo no hace nada');
    // El historial de movimientos lo muestra con la marca
    const m = (await t.admin('GET', '/api/stock/movements')).data.find((x) => x.reason === 'limpieza' && x.article_id === remera.id);
    assert.equal(m.brand, 'Koxis'); assert.equal(m.qty, -8);
  } finally { t.close(); }
});

test('modo «borrar todo»: se borra lo que nunca se vendió y lo vendido queda dado de baja con su historial', async () => {
  const t = await start();
  try {
    const remera = await escenario(t);
    const r = (await t.admin('POST', CLEAR, { mode: 'delete', confirm: 'LIMPIAR' })).data;
    assert.deepEqual({ ...r }, { mode: 'delete', zeroed: 2, units: 12, deleted: 2, deactivated: 1, backup: false });
    assert.deepEqual((await t.admin('GET', '/api/articles')).data, [], 'el listado queda vacío');
    const todos = (await t.admin('GET', '/api/articles?all=1')).data;
    assert.deepEqual(todos.map((a) => [a.id, a.active, a.stock]), [[remera.id, 0, 0]], 'queda solo el que tiene ventas, dado de baja');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE article_id NOT IN (SELECT id FROM articles)').get().n, 0, 'sin movimientos huérfanos');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sale_items').get().n, 1, 'el detalle de las ventas sigue');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sales WHERE voided = 0').get().n, 1);
    assert.deepEqual((await t.admin('GET', '/api/brands')).data.map((b) => b.name), ['Adicta', 'Inversa', 'Koxis'], 'las marcas se conservan');
    assert.equal((await t.admin('GET', '/api/stock/summary')).data.skus, 0);
    assert.deepEqual({ ...(await t.admin('GET', PREV)).data }, { total: 1, active: 0, units: 0, with_sales: 1, deletable: 0, backup: false });

    // Se puede volver a cargar una planilla: el artículo dado de baja se reactiva por su código
    const xlsx = buildXlsx([{ name: 'Artículos', rows: [HEAD, ['R1', 'Koxis', 'Remera', '', '', '', 1500, '', 7, ''], ['N1', 'Koxis', 'Nuevo', '', '', '', 100, '', 3, '']] }]);
    const pv = (await t.admin('POST', '/api/import/preview', { filename: 'a.xlsx', data: xlsx.toString('base64') })).data;
    assert.equal(pv.existingRows, 1, 'reconoce el que quedó dado de baja');
    const st = (await t.admin('POST', '/api/import/start', { token: pv.token, mode: 'replace' })).data;
    for (let i = 0; i < 200; i++) { if ((await t.admin('GET', `/api/import/${st.id}`)).data.state !== 'running') break; await new Promise((x) => setTimeout(x, 10)); }
    assert.deepEqual((await t.admin('GET', '/api/articles')).data.map((a) => [a.barcode, a.stock]).sort(), [['N1', 3], ['R1', 7]]);
  } finally { t.close(); }
});

test('con carpeta de copias configurada: primero hace una copia verificada, y si falla no toca nada', async () => {
  const t = await start();
  const dir = mkdtempSync(join(tmpdir(), 'liuvi-clr-'));
  try {
    await escenario(t);
    assert.equal((await t.admin('PUT', '/api/backup', { dir, auto: false })).status, 200);
    assert.equal((await t.admin('GET', PREV)).data.backup, true);
    const r = (await t.admin('POST', CLEAR, { mode: 'delete', confirm: 'LIMPIAR' })).data;
    assert.equal(r.backup, true);
    const copias = readdirSync(dir).filter((f) => f.endsWith('.db'));
    assert.equal(copias.length, 1, 'se hizo una copia aunque las automáticas estén apagadas');
    const copia = new DatabaseSync(join(dir, copias[0]), { readOnly: true });
    assert.equal(copia.prepare('SELECT COUNT(*) n FROM articles').get().n, 3, 'la copia tiene los artículos de antes de limpiar');
    copia.close();
    assert.equal((await t.admin('GET', '/api/backup')).data.last_reason, 'antes de limpiar el stock');

    // Si la carpeta dejó de existir, no se limpia
    await mk(t, null, { barcode: 'X9', name: 'Otro', stock: 3 });
    rmSync(dir, { recursive: true, force: true });
    const falla = await t.admin('POST', CLEAR, { mode: 'zero', confirm: 'LIMPIAR' });
    assert.equal(falla.status, 500); assert.match(falla.data.error, /No se limpió nada.*copia de seguridad/);
    assert.equal(t.db.prepare("SELECT stock FROM articles WHERE barcode = 'X9'").get().stock, 3, 'no se tocó nada');
  } finally { t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('no se puede limpiar mientras hay una carga de Excel en curso', async () => {
  const t = await start();
  try {
    const rows = Array.from({ length: 12000 }, (_, i) => [`C${i}`, 'Koxis', `Art ${i}`, '', '', '', 100, '', 1, '']);
    const xlsx = buildXlsx([{ name: 'Artículos', rows: [HEAD, ...rows] }]);
    const pv = (await t.admin('POST', '/api/import/preview', { filename: 'g.xlsx', data: xlsx.toString('base64') })).data;
    const st = await t.admin('POST', '/api/import/start', { token: pv.token, mode: 'skip' });
    assert.equal(st.status, 202);
    const r = await t.admin('POST', CLEAR, { mode: 'delete', confirm: 'LIMPIAR' });
    assert.equal(r.status, 409); assert.match(r.data.error, /carga de Excel en curso/);
    for (let i = 0; i < 1500; i++) { if ((await t.admin('GET', `/api/import/${st.data.id}`)).data.state !== 'running') break; await new Promise((x) => setTimeout(x, 10)); }
    assert.equal((await t.admin('POST', CLEAR, { mode: 'delete', confirm: 'LIMPIAR' })).status, 200, 'terminada la carga, sí');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM articles').get().n, 0);
  } finally { t.close(); }
});
