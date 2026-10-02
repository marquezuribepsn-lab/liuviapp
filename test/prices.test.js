import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('cambio masivo de precios: filtros, redondeo, costos, historial y deshacer', async () => {
  const t = await start();
  try {
    const mk = async (b) => (await t.admin('POST', '/api/articles', { stock: 3, ...b })).data;
    const r1 = await mk({ name: 'Remera', brand: 'Koxis', category: 'Remeras', price: 10000, cost: 4000 });
    const r2 = await mk({ name: 'Top', brand: 'Koxis', category: 'Tops', price: 7000, cost: 2500 });
    const j = await mk({ name: 'Jean', brand: 'Adicta', category: 'Jeans', price: 30000, cost: 12000 });
    await mk({ name: 'Sin stock', brand: 'Koxis', category: 'Tops', price: 5000, cost: 1000, stock: 0 });
    const price = async (id) => (await t.admin('GET', '/api/articles?all=1')).data.find((a) => a.id === id);
    const brands = (await t.admin('GET', '/api/brands')).data;
    const koxis = brands.find((b) => b.name === 'Koxis').id;

    const pv = await t.admin('POST', '/api/prices/preview', { brand_id: koxis, mode: 'percent', value: 15, round: 100 });
    assert.equal(pv.data.total, 3);
    assert.equal(pv.data.changed, 3);
    assert.equal((await price(r1.id)).price, 10000, 'la vista previa no cambia nada');
    assert.equal(pv.data.items.find((i) => i.id === r2.id).new_price, 8100, '7000 + 15% = 8050 → redondeo a 100 = 8100 (sin errores de coma flotante)');

    // Aplicar: solo la marca elegida y solo con stock; el costo no se toca si se cambia solo el precio
    const ap = await t.admin('POST', '/api/prices/apply', { brand_id: koxis, only_stock: true, mode: 'percent', value: 10, round: 0 });
    assert.equal(ap.data.changed, 2);
    assert.equal((await price(r1.id)).price, 11000);
    assert.equal((await price(r1.id)).cost, 4000);
    assert.equal((await price(j.id)).price, 30000, 'otra marca: sin cambios');

    // Costo + precio por monto fijo, filtrando por categoría
    await t.admin('POST', '/api/prices/apply', { category: 'jeans', target: 'both', mode: 'amount', value: -2000 });
    assert.equal((await price(j.id)).price, 28000);
    assert.equal((await price(j.id)).cost, 10000);

    // Artículos puntuales: solo los elegidos, sin importar marca ni filtros
    const puntual = await t.admin('POST', '/api/prices/apply', { article_ids: [r2.id], mode: 'percent', value: 10, round: 0 });
    assert.equal(puntual.data.changed, 1);
    assert.equal((await price(r2.id)).price, 8470, '7700 + 10 %');
    assert.equal((await price(r1.id)).price, 11000, 'los demás de la marca no cambian');
    assert.equal((await t.admin('POST', '/api/prices/preview', { article_ids: [], mode: 'percent', value: 10 })).status, 400, 'sin artículos elegidos no hay nada que cambiar');
    assert.equal((await t.admin('POST', '/api/prices/undo', {})).status, 200);
    assert.equal((await price(r2.id)).price, 7700, 'se deshace también el cambio puntual');

    // Validaciones
    assert.equal((await t.admin('POST', '/api/prices/preview', { mode: 'percent', value: 0 })).status, 400);
    assert.equal((await t.admin('POST', '/api/prices/preview', { mode: 'percent', value: -95 })).status, 400);
    assert.equal((await t.admin('POST', '/api/prices/preview', { mode: 'percent', value: 5, round: 7 })).status, 400);
    assert.equal((await t.admin('POST', '/api/prices/apply', { brand_id: 999, mode: 'percent', value: 5 })).status, 400, 'si no cambia nada, no registra una tanda vacía');

    // Historial y deshacer (de la última tanda hacia atrás)
    assert.equal((await t.admin('GET', '/api/prices/history')).data.length, 3);
    assert.equal((await t.admin('POST', '/api/prices/undo', {})).data.restored, 1);
    assert.equal((await price(j.id)).price, 30000);
    assert.equal((await price(j.id)).cost, 12000);
    assert.equal((await price(r1.id)).price, 11000, 'la tanda anterior sigue aplicada');
    await t.admin('POST', '/api/prices/undo', {});
    assert.equal((await price(r1.id)).price, 10000);
    assert.equal((await t.admin('POST', '/api/prices/undo', {})).status, 400, 'no queda nada para deshacer');

    // Sin permiso de artículos o de costos
    const roles = (await t.admin('GET', '/api/roles')).data;
    await t.admin('POST', '/api/users', { username: 'ana', name: 'Ana', password: 'clave-ana-123', role_id: roles.find((r) => r.name === 'Vendedor').id });
    const ana = t.client(); await ana.call('POST', '/api/auth/login', { username: 'ana', password: 'clave-ana-123' });
    assert.equal((await ana.call('POST', '/api/prices/preview', { mode: 'percent', value: 5 })).status, 403);
    const rol = (await t.admin('POST', '/api/roles', { name: 'Precios', permissions: ['articulos.ver', 'articulos.editar'] })).data;
    await t.admin('POST', '/api/users', { username: 'leo', name: 'Leo', password: 'clave-leo-123', role_id: rol.id });
    const leo = t.client(); await leo.call('POST', '/api/auth/login', { username: 'leo', password: 'clave-leo-123' });
    assert.equal((await leo.call('POST', '/api/prices/preview', { mode: 'percent', value: 5, target: 'cost' })).status, 403);
    const pl = await leo.call('POST', '/api/prices/preview', { mode: 'percent', value: 5 });
    assert.equal(pl.status, 200);
    assert.equal(pl.data.items[0].old_cost, undefined, 'sin permiso de costos no se ven');
  } finally { t.close(); }
});
