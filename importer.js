// Carga de artículos desde una planilla (Excel .xlsx o CSV): validación, análisis previo y carga por tandas con avance.
import { randomBytes } from 'node:crypto';
import { readSheet, buildXlsx, SheetFormatError } from './xlsx.js';

export { SheetFormatError };
export class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MAX_ROWS = 20_000;
const CHUNK = 25;                  // filas por transacción: entre tandas el servidor atiende otros pedidos y se informa el avance
const PREVIEW_TTL = 30 * 60_000;
const JOB_TTL = 60 * 60_000;
export const MODES = ['skip', 'replace', 'add'];

export const FIELDS = [
  { key: 'barcode', title: 'Código de barras', aliases: ['codigo de barras', 'codigo barras', 'codigo', 'cod barras', 'cod', 'barcode', 'ean', 'sku'] },
  { key: 'brand', title: 'Marca', aliases: ['marca', 'brand'] },
  { key: 'name', title: 'Artículo', aliases: ['articulo', 'nombre', 'producto', 'descripcion', 'detalle'] },
  { key: 'category', title: 'Categoría', aliases: ['categoria', 'rubro', 'tipo', 'linea'] },
  { key: 'size', title: 'Talle', aliases: ['talle', 'talla', 'size'] },
  { key: 'color', title: 'Color', aliases: ['color', 'colour'] },
  { key: 'price', title: 'Precio', aliases: ['precio', 'precio venta', 'precio de venta', 'pvp', 'precio publico', 'precio al publico', 'precio lista'] },
  { key: 'cost', title: 'Costo', aliases: ['costo', 'precio costo', 'precio de costo'] },
  { key: 'stock', title: 'Stock', aliases: ['stock', 'cantidad', 'existencia', 'existencias', 'unidades'] },
  { key: 'min_stock', title: 'Stock mínimo', aliases: ['stock minimo', 'minimo', 'stock min', 'min'] },
];

// «Cód.», «CÓDIGO DE BARRAS», «Precio de venta»… -> texto comparable
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ALIAS = new Map(FIELDS.flatMap((f) => f.aliases.map((a) => [a, f.key])));
const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

// Acepta 12500, "12500,50", "12.500,50", "$ 12.500" (formato argentino) y "12500.5".
export function parseNumber(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  let s = v.replace(/[\s$]|ars|pesos/gi, '');
  if (s === '') return undefined;
  if (!/^-?[\d.,]+$/.test(s)) return NaN;
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (commas) s = commas > 1 ? s.replaceAll(',', '') : s.replace(',', '.');
  else if (dots > 1 || /^-?\d{1,3}\.\d{3}$/.test(s)) s = s.replaceAll('.', ''); // 38.000 = treinta y ocho mil
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const BARCODE_RE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

// Filas de la planilla -> artículos validados. Las filas con problemas se informan y no se cargan.
export function parseArticleSheet(rows) {
  let header = null, colOf = {};
  for (const r of rows.slice(0, 30)) {
    const map = {};
    r.cells.forEach((c, i) => { const key = ALIAS.get(norm(c)); if (key && !(key in map)) map[key] = i; });
    if ('name' in map && 'price' in map) { header = r; colOf = map; break; }
  }
  if (!header) {
    throw new SheetFormatError('No encontré los títulos de las columnas. La planilla necesita, como mínimo, las columnas «Artículo» y «Precio» (y puede tener Código de barras, Marca, Categoría, Talle, Color, Costo, Stock y Stock mínimo). Bajá la planilla modelo desde esta misma ventana.');
  }
  const columns = FIELDS.map((f) => ({ key: f.key, title: f.title, found: f.key in colOf }));
  const items = [], errors = [];
  const seenCode = new Map(), seenKey = new Map();
  let total = 0;
  for (const r of rows) {
    if (r.n <= header.n) continue;
    if (r.cells.every((c) => c == null || String(c).trim() === '')) continue; // fila vacía
    total++;
    if (total > MAX_ROWS) throw new SheetFormatError(`La planilla tiene más de ${MAX_ROWS.toLocaleString('es-AR')} filas. Dividila en archivos más chicos.`);
    const cell = (k) => (k in colOf ? r.cells[colOf[k]] : undefined);
    const bad = [];
    const it = { n: r.n };

    const name = clean(cell('name'));
    if (!name) bad.push('falta el nombre del artículo'); else if (name.length > 120) bad.push('el nombre supera los 120 caracteres'); else it.name = name;

    for (const [k, label, max] of [['brand', 'la marca', 40], ['category', 'la categoría', 60], ['size', 'el talle', 20], ['color', 'el color', 40]]) {
      const v = clean(cell(k));
      if (v.length > max) bad.push(`${label} supera los ${max} caracteres`); else if (v) it[k] = v;
    }

    const rawCode = cell('barcode');
    if (rawCode != null && String(rawCode).trim() !== '') {
      const code = typeof rawCode === 'number' ? (Number.isInteger(rawCode) && rawCode >= 0 ? String(rawCode) : '') : String(rawCode).trim();
      if (!code || code.length > 64 || !BARCODE_RE.test(code)) bad.push('el código de barras tiene caracteres no permitidos');
      else it.barcode = code;
    }

    const price = parseNumber(cell('price'));
    if (price === undefined) bad.push('falta el precio'); else if (!Number.isFinite(price) || price < 0) bad.push('el precio no es un número válido'); else it.price = price;
    const cost = parseNumber(cell('cost'));
    if (cost !== undefined) { if (!Number.isFinite(cost) || cost < 0) bad.push('el costo no es un número válido'); else it.cost = cost; }
    for (const [k, label] of [['stock', 'el stock'], ['min_stock', 'el stock mínimo']]) {
      const n = parseNumber(cell(k));
      if (n === undefined) continue;
      if (!Number.isInteger(n) || n < 0) bad.push(`${label} tiene que ser un número entero, 0 o más`); else it[k] = n;
    }

    if (!bad.length) {
      if (it.barcode) {
        if (seenCode.has(it.barcode)) bad.push(`el código de barras ya está en la fila ${seenCode.get(it.barcode)}`); else seenCode.set(it.barcode, r.n);
      } else {
        const key = [it.brand, it.name, it.size, it.color].map((x) => (x ?? '').toLowerCase()).join('|');
        if (seenKey.has(key)) bad.push(`es el mismo artículo (marca, nombre, talle y color) que la fila ${seenKey.get(key)}, y no tiene código de barras para distinguirlos`); else seenKey.set(key, r.n);
      }
    }
    if (bad.length) errors.push({ row: r.n, message: bad.join('; ') }); else items.push(it);
  }
  return { headerRow: header.n, columns, items, errors, totalRows: total };
}

export function buildTemplate() {
  const H = (v) => ({ v, s: 1 });
  const colsInfo = [
    ['Código de barras', 'No', 'El del producto. Si lo dejás vacío, el programa crea uno. Usá formato Texto en esa columna para no perder ceros.', '7790001112223'],
    ['Marca', 'No', 'Koxis, Adicta, Inversa… Si la marca no existe, se crea.', 'Koxis'],
    ['Artículo', 'SÍ', 'Nombre del artículo.', 'Remera básica'],
    ['Categoría', 'No', 'Para agrupar: Remeras, Pantalones, Vestidos…', 'Remeras'],
    ['Talle', 'No', 'Letra o número.', 'M'],
    ['Color', 'No', '', 'Negro'],
    ['Precio', 'SÍ', 'Precio de venta. Se entiende 12500, 12500,50 y $ 12.500,50.', '12500'],
    ['Costo', 'No', 'Lo que te cuesta a vos (solo lo carga quien tiene permiso de ver costos).', '5000'],
    ['Stock', 'No', 'Unidades que tenés ahora.', '10'],
    ['Stock mínimo', 'No', 'Debajo de este número el programa avisa «stock bajo».', '3'],
  ];
  const notes = [
    'Cada fila es UN artículo en UN talle y UN color: una remera en 4 talles son 4 filas.',
    'No cambies los títulos de la primera fila de la hoja «Artículos». Las columnas pueden ir en otro orden y podés borrar las que no uses (solo «Artículo» y «Precio» son obligatorias).',
    'Al cargar, el programa te muestra primero un resumen y los errores (con el número de fila) y recién después carga. Las filas con errores no se cargan; el resto sí.',
    'Podés volver a cargar la misma planilla sin duplicar nada: si el código ya existe, elegís si se omite, se actualiza o se suma el stock. Si no tiene código, se reconoce por marca + nombre + talle + color.',
    'También se puede cargar un archivo CSV (Archivo → Guardar como → CSV).',
  ];
  return buildXlsx([
    { name: 'Artículos', widths: [22, 14, 28, 18, 9, 14, 12, 12, 9, 14], colStyles: [2, 0, 0, 0, 2, 0, 0, 0, 0, 0], freezeHeader: true, rows: [FIELDS.map((f) => H(f.title))] },
    {
      name: 'Instrucciones', widths: [22, 12, 70, 18],
      rows: [
        [{ v: 'Cómo cargar artículos desde Excel', s: 4 }], [],
        ...notes.map((t) => [{ v: '• ' + t, s: 3 }]), [],
        [H('Columna'), H('¿Obligatoria?'), H('Qué poner'), H('Ejemplo')],
        ...colsInfo.map(([a, b, c, d]) => [{ v: a, s: 5 }, { v: b, s: 3 }, { v: c, s: 3 }, { v: d, s: 3 }]),
      ],
    },
  ]);
}

export function createImporter(db, { resolveBrand, moveStock, tx }) {
  const previews = new Map(), jobs = new Map();
  let running = null;
  const byBarcode = db.prepare('SELECT id, stock FROM articles WHERE barcode = ?');
  const byKey = db.prepare(`
    SELECT a.id, a.stock FROM articles a LEFT JOIN brands b ON b.id = a.brand_id
    WHERE lower(a.name) = lower(?) AND lower(a.size) = lower(?) AND lower(a.color) = lower(?) AND lower(COALESCE(b.name, '')) = lower(?)
    ORDER BY a.active DESC, a.id LIMIT 1`);
  const codeTaken = db.prepare('SELECT 1 FROM articles WHERE barcode = ?');
  // Con código se busca por código; sin código, por marca + nombre + talle + color.
  const findExisting = (it) => (it.barcode ? byBarcode.get(it.barcode) : byKey.get(it.name, it.size ?? '', it.color ?? '', it.brand ?? ''));

  function newCode() { // código interno EAN-13 (prefijo 200, de uso interno) con dígito verificador
    for (;;) {
      const body = '200' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
      const sum = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
      const code = body + ((10 - (sum % 10)) % 10);
      if (!codeTaken.get(code)) return code;
    }
  }

  const sweep = () => {
    const now = Date.now();
    for (const [k, p] of previews) if (now - p.createdAt > PREVIEW_TTL) previews.delete(k);
    for (const [k, j] of jobs) if (j.state !== 'running' && now - j.finishedAt > JOB_TTL) jobs.delete(k);
  };

  function preview(userId, { filename, data }) {
    sweep();
    if (typeof data !== 'string' || !data) throw new ImportError(400, 'No se recibió ningún archivo.');
    const { sheetName, rows } = readSheet(Buffer.from(data, 'base64'), String(filename || ''));
    const parsed = parseArticleSheet(rows);
    const known = new Set(db.prepare('SELECT name FROM brands').all().map((b) => b.name.toLowerCase()));
    const newBrands = new Map();
    let fresh = 0, existing = 0, noCode = 0;
    for (const it of parsed.items) {
      if (!it.barcode) noCode++;
      if (findExisting(it)) existing++; else fresh++;
      if (it.brand && !known.has(it.brand.toLowerCase()) && !newBrands.has(it.brand.toLowerCase())) newBrands.set(it.brand.toLowerCase(), it.brand);
    }
    const token = randomBytes(12).toString('base64url');
    previews.set(token, { userId, items: parsed.items, errors: parsed.errors, createdAt: Date.now() });
    while (previews.size > 5) previews.delete(previews.keys().next().value);
    return {
      token, filename: String(filename || ''), sheet: sheetName, headerRow: parsed.headerRow, columns: parsed.columns,
      totalRows: parsed.totalRows, validRows: parsed.items.length, newRows: fresh, existingRows: existing, noCodeRows: noCode,
      newBrands: [...newBrands.values()], errorCount: parsed.errors.length, errors: parsed.errors.slice(0, 100),
      sample: parsed.items.slice(0, 5),
    };
  }

  function applyRow(c, job, it) {
    const existing = findExisting(it);
    if (existing) {
      if (job.mode === 'skip') { c.skipped++; return; }
      const sets = ['active = 1'], vals = [];
      const put = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
      put('name', it.name); put('price', it.price);
      for (const k of ['category', 'size', 'color']) if (it[k] !== undefined) put(k, it[k]);
      if (it.cost !== undefined && job.canCost) put('cost', it.cost);
      if (it.min_stock !== undefined) put('min_stock', it.min_stock);
      if (it.brand !== undefined) put('brand_id', resolveBrand(it.brand));
      db.prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`).run(...vals, existing.id);
      if (it.stock !== undefined) {
        if (job.mode === 'replace' && it.stock !== existing.stock) moveStock(existing.id, it.stock - existing.stock, 'ajuste', null, job.userId);
        if (job.mode === 'add' && it.stock > 0) moveStock(existing.id, it.stock, 'compra', null, job.userId);
      }
      c.updated++;
      return;
    }
    const barcode = it.barcode ?? (job.genCodes ? newCode() : null);
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO articles (barcode, name, category, size, color, price, cost, stock, min_stock, brand_id)
      VALUES (?,?,?,?,?,?,?,0,?,?)`).run(barcode, it.name, it.category ?? '', it.size ?? '', it.color ?? '', it.price,
      job.canCost ? (it.cost ?? 0) : 0, it.min_stock ?? 1, it.brand ? resolveBrand(it.brand) : null);
    if (it.stock) moveStock(id, it.stock, 'inicial', null, job.userId);
    c.created++;
  }

  const brandCount = db.prepare('SELECT COUNT(*) AS n FROM brands');
  function step(job) {
    const slice = job.items.slice(job.i, job.i + CHUNK);
    const c = { created: 0, updated: 0, skipped: 0 };
    try {
      const before = brandCount.get().n;
      tx(db, () => { for (const it of slice) applyRow(c, job, it); });
      job.brandsCreated += brandCount.get().n - before;
      job.i += slice.length; job.done = job.i;
      job.created += c.created; job.updated += c.updated; job.skipped += c.skipped;
    } catch (e) {
      job.state = 'error'; job.message = `Se detuvo la carga: ${e.message}. Lo que ya se cargó quedó guardado; podés volver a subir la misma planilla y se completa sin duplicar.`;
    }
    if (job.state === 'running') {
      if (job.i >= job.items.length) { job.state = 'done'; job.message = 'Carga finalizada.'; } else return setImmediate(() => step(job));
    }
    job.finishedAt = Date.now(); job.items = null; running = null;
  }

  function start(userId, { token, mode, genCodes }, { canCost }) {
    sweep();
    if (running) throw new ImportError(409, 'Ya hay una carga en curso. Esperá a que termine.');
    const p = previews.get(token);
    if (!p || p.userId !== userId) throw new ImportError(404, 'La planilla analizada venció. Volvé a subir el archivo.');
    if (!MODES.includes(mode)) throw new ImportError(400, 'Elegí qué hacer con los artículos que ya existen.');
    previews.delete(token);
    const job = {
      id: token, userId, state: 'running', mode, genCodes: genCodes !== false, canCost: !!canCost, items: p.items, i: 0,
      total: p.items.length, done: 0, created: 0, updated: 0, skipped: 0, brandsCreated: 0,
      errorCount: p.errors.length, errors: p.errors.slice(0, 100), message: '', startedAt: Date.now(), finishedAt: 0,
    };
    jobs.set(job.id, job);
    running = job;
    setImmediate(() => step(job));
    return status(job.id);
  }

  function status(id) {
    const j = jobs.get(id);
    if (!j) throw new ImportError(404, 'No se encontró esa carga (puede haber vencido).');
    return {
      id: j.id, state: j.state, mode: j.mode, total: j.total, done: j.done, created: j.created, updated: j.updated, skipped: j.skipped,
      brandsCreated: j.brandsCreated, errorCount: j.errorCount, errors: j.errors, message: j.message,
      durationMs: (j.finishedAt || Date.now()) - j.startedAt,
    };
  }

  return { preview, start, status, template: buildTemplate };
}
