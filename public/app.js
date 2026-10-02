const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(n || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (s) => s.slice(11, 16);

async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  api.total = res.headers.get('X-Total-Count') === null ? null : Number(res.headers.get('X-Total-Count')); // total real de un listado
  if (res.status === 401 && !path.startsWith('/auth/')) { if (data?.locked) showLock(); else showLogin(); }
  if (!res.ok) { const err = new Error(data?.error || 'Error de servidor'); err.locked = !!data?.locked; throw err; }
  return data;
}
let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (error ? ' error' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3000);
}
let me = null; // { user, permissions } de la sesión
const can = (p) => !!me?.user?.permissions.includes(p);
const canAny = (...ps) => ps.some(can);
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const articleLabel = (a) => [a.brand, a.name, a.size && `Talle ${a.size}`, a.color].filter(Boolean).join(' · ');

// ---------- Pestañas ----------
let currentTab = 'venta';
const loaders = { venta: loadCash, etiquetas: loadPrintTab, articulos: loadArticles, stock: loadStock, stats: loadStats, usuarios: loadUsers, copias: loadBackup };
const TAB_PERMS = { venta: ['ventas.cobrar', 'caja.ver', 'caja.operar'], articulos: ['articulos.ver'], etiquetas: ['articulos.ver'], stock: ['stock.ver'], stats: ['estadisticas.ver'], usuarios: ['usuarios.admin'], copias: ['sistema.copias'] };
function showTab(name) {
  currentTab = name;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((s) => (s.hidden = s.id !== name));
  guard(loaders[name])();
  if (name === 'venta') $('#scan').focus();
}
$('#tabs').addEventListener('click', (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));

// En la pantalla de venta, cualquier tecla (o el lector) va al campo de escaneo.
document.addEventListener('keydown', (e) => {
  if (currentTab !== 'venta' || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) || $('dialog[open]') || $('#posBox').hidden) return;
  $('#scan').focus();
});

// ---------- Caja (estado global) ----------
let cash = null;
async function refreshCash() {
  cash = await api('GET', '/cash/current');
  const b = $('#cashBadge');
  b.textContent = cash ? `Caja abierta · #${cash.id}` : 'Caja cerrada';
  b.className = 'badge ' + (cash ? 'on' : 'off');
}

// ---------- Venta ----------
let cart = [];
const cartTotals = () => {
  const subtotal = cart.reduce((s, l) => s + l.a.price * l.qty, 0);
  const pct = Math.min(100, Math.max(0, Number($('#discount').value) || 0));
  const total = Math.round(subtotal * (100 - pct)) / 100;
  return { subtotal, total };
};
function renderCart() {
  $('#cart tbody').innerHTML = cart.map((l, i) => `
    <tr><td>${esc(articleLabel(l.a))}</td>
    <td><button class="link" data-q="${i}:-1">−</button> ${l.qty} <button class="link" data-q="${i}:1">+</button></td>
    <td class="num">${money(l.a.price)}</td><td class="num">${money(l.a.price * l.qty)}</td>
    <td><button class="link" data-rm="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Escaneá un artículo para empezar</td></tr>';
  const { subtotal, total } = cartTotals();
  $('#subtotal').textContent = money(subtotal);
  $('#total').textContent = money(total);
  updateChange();
}
function paymentsEntered() {
  return ['Efectivo', 'Tarjeta', 'Transferencia'].map((m) => ({ method: m.toLowerCase(), amount: Number($('#pay' + m).value) || 0 })).filter((p) => p.amount > 0);
}
function updateChange() {
  const { total } = cartTotals();
  const paid = paymentsEntered().reduce((s, p) => s + p.amount, 0);
  const diff = Math.round((paid - total) * 100) / 100;
  $('#change').textContent = !cart.length ? '' : diff >= 0 ? `Vuelto: ${money(diff)}` : `Falta cobrar: ${money(-diff)}`;
}
function addToCart(a) {
  const line = cart.find((l) => l.a.id === a.id);
  const qty = (line?.qty || 0) + 1;
  if (qty > a.stock) return toast(`Sin stock suficiente de ${articleLabel(a)} (hay ${a.stock})`, true);
  if (line) line.qty = qty; else cart.push({ a, qty: 1 });
  renderCart();
}
$('#cart').addEventListener('click', (e) => {
  const q = e.target.dataset.q, rm = e.target.dataset.rm;
  if (q) {
    const [i, d] = q.split(':').map(Number), l = cart[i];
    const n = l.qty + d;
    if (n < 1) cart.splice(i, 1); else if (n > l.a.stock) return toast('Sin stock suficiente', true); else l.qty = n;
    renderCart();
  } else if (rm !== undefined) { cart.splice(Number(rm), 1); renderCart(); }
});
$('#discount').addEventListener('input', renderCart);
['Efectivo', 'Tarjeta', 'Transferencia'].forEach((m) => $('#pay' + m).addEventListener('input', updateChange));
$$('[data-full]').forEach((b) => b.addEventListener('click', () => {
  ['Efectivo', 'Tarjeta', 'Transferencia'].forEach((m) => ($('#pay' + m).value = ''));
  $('#pay' + b.dataset.full).value = cartTotals().total || '';
  updateChange();
}));
function resetSale() {
  cart = []; $('#discount').value = 0; $('#custName').value = ''; $('#custDoc').value = '';
  ['Efectivo', 'Tarjeta', 'Transferencia'].forEach((m) => ($('#pay' + m).value = ''));
  renderCart(); $('#results').innerHTML = ''; $('#scan').value = ''; $('#scan').focus();
}
$('#clearCart').addEventListener('click', resetSale);

async function searchInto(box, q, onPick) {
  const list = q ? await api('GET', '/articles?q=' + encodeURIComponent(q)) : [];
  box.innerHTML = list.map((a) => `<div class="item" data-id="${a.id}"><span>${esc(articleLabel(a))}</span><span>${money(a.price)} · stock ${a.stock}</span></div>`).join('');
  box.onclick = (e) => { const el = e.target.closest('.item'); if (el) onPick(list.find((a) => a.id == el.dataset.id)); };
  return list;
}
const liveSearch = debounce(guard(() => searchInto($('#results'), $('#scan').value.trim(), (a) => { addToCart(a); $('#results').innerHTML = ''; $('#scan').value = ''; $('#scan').focus(); })));
$('#scan').addEventListener('input', liveSearch);
// El lector envía el código seguido de Enter.
$('#scan').addEventListener('keydown', guard(async (e) => {
  if (e.key !== 'Enter') return;
  const code = e.target.value.trim();
  if (!code) return;
  e.preventDefault();
  try {
    addToCart(await api('GET', '/articles/barcode/' + encodeURIComponent(code)));
    e.target.value = ''; $('#results').innerHTML = '';
  } catch {
    const list = await searchInto($('#results'), code, () => {});
    if (list.length === 1) { addToCart(list[0]); e.target.value = ''; $('#results').innerHTML = ''; }
    else toast(list.length ? 'Elegí un artículo de la lista' : 'Código o artículo no encontrado', !list.length);
  }
}));
$('#charge').addEventListener('click', guard(async () => {
  if (!cart.length) throw new Error('La venta está vacía');
  if (!cash) throw new Error('Abrí la caja antes de vender');
  const payments = paymentsEntered();
  const { total } = cartTotals();
  if (!payments.length) payments.push({ method: 'efectivo', amount: total }); // por defecto: efectivo exacto
  const sale = await api('POST', '/sales', { items: cart.map((l) => ({ article_id: l.a.id, qty: l.qty })), discount_pct: Number($('#discount').value) || 0, payments, customer_name: $('#custName').value, customer_doc: $('#custDoc').value });
  toast(`Venta #${sale.id} registrada${sale.change ? ` · Vuelto ${money(sale.change)}` : ''}`);
  resetSale(); await loadCash();
  const full = (await api('GET', '/sales')).find((x) => x.id === sale.id);
  lastTicket = { ...full, change: sale.change };
  if ($('#autoTicket').checked && full) printTicket(lastTicket);
}));

// ---------- Artículos ----------
async function loadArticles() {
  const q = encodeURIComponent($('#artSearch').value.trim());
  const brandSel = $('#artBrand').value;
  const rows = await api('GET', `/articles?q=${q}&low=${$('#artLow').checked ? 1 : 0}${brandSel ? `&brand_id=${brandSel}` : ''}`);
  $('#artTable tbody').innerHTML = rows.map((a) => `
    <tr><td>${esc(a.barcode || '—')}</td><td>${esc(a.brand || '—')}</td><td>${esc(a.name)}</td><td>${esc(a.category)}</td><td>${esc(a.size)}</td><td>${esc(a.color)}</td>
    <td class="num">${money(a.price)}</td><td class="num col-cost">${money(a.cost)}</td>
    <td class="num ${a.stock <= a.min_stock ? 'low' : ''}">${a.stock}</td>
    <td>${can('articulos.editar') ? `<button class="link" data-edit="${a.id}">Editar</button>` : ''}<button class="link" data-lbl="${a.id}">Etiqueta</button>${can('articulos.editar') ? `<button class="link" data-del="${a.id}">Baja</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="10" class="muted">Sin artículos</td></tr>';
  window._arts = rows;
  const total = api.total;
  $('#artNote').textContent = total == null ? '' : total > rows.length
    ? `Mostrando ${rows.length} de ${total} artículos. Usá la búsqueda o el filtro de marca para ver el resto.`
    : `${total} artículo${total === 1 ? '' : 's'}.`;
  await loadBrands();
  const cats = await api('GET', '/articles');
  $('#cats').innerHTML = [...new Set(cats.map((a) => a.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('');
}
// Marcas: filtro, sugerencias del formulario y administración.
async function loadBrands() {
  const brands = await api('GET', '/brands');
  const sel = $('#artBrand'), keep = sel.value;
  sel.innerHTML = '<option value="">Todas las marcas</option>' + brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  sel.value = keep;
  const sb = $('#sbBrand'), keepSb = sb.value;
  sb.innerHTML = '<option value="">Todas las marcas</option>' + brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  sb.value = keepSb;
  $('#brandList').innerHTML = brands.map((b) => `<option value="${esc(b.name)}">`).join('');
  const edit = can('articulos.editar');
  $('#brandForm').hidden = !edit;
  $('#brandsTable tbody').innerHTML = brands.map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${b.articles}</td>
    <td>${edit ? `<button class="link" data-brename="${b.id}" data-name="${esc(b.name)}">Renombrar</button><button class="link" data-bdel="${b.id}">Borrar</button>` : ''}</td></tr>`).join('');
}
$('#artBrand').addEventListener('change', guard(loadArticles));
$('#brandForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await api('POST', '/brands', { name: $('#brandNew').value });
  $('#brandNew').value = ''; toast('Marca agregada'); await loadBrands();
}));
$('#brandsTable').addEventListener('click', guard(async (e) => {
  const d = e.target.dataset;
  if (d.brename) {
    const name = prompt('Nuevo nombre de la marca:', d.name);
    if (name === null) return;
    await api('PUT', '/brands/' + d.brename, { name }); toast('Marca renombrada'); await loadArticles();
  }
  if (d.bdel && confirm('¿Borrar esta marca? Solo se puede si no tiene artículos.')) { await api('DELETE', '/brands/' + d.bdel); toast('Marca borrada'); await loadBrands(); }
}));
$('#artSearch').addEventListener('input', debounce(guard(loadArticles)));
$('#artLow').addEventListener('change', guard(loadArticles));
let editingId = null;
function openArtDialog(a) {
  editingId = a?.id ?? null;
  const f = $('#artForm');
  f.reset();
  $('#artTitle').textContent = a ? 'Editar artículo' : 'Nuevo artículo';
  $('#stockInitial').hidden = !!a;
  for (const k of ['barcode', 'brand', 'name', 'category', 'size', 'color', 'price', 'cost', 'min_stock']) if (a) f.elements[k].value = a[k] ?? '';
  $('#artDialog').showModal();
  f.elements.barcode.focus();
}
$('#artNew').addEventListener('click', () => openArtDialog());
$('#artCancel').addEventListener('click', () => $('#artDialog').close());
// Evita que el Enter del lector envíe el formulario al escanear en el campo de código.
$('#artForm').elements.barcode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#artForm').elements.name.focus(); } });
$('#genCode').addEventListener('click', () => {
  // Código interno de 13 dígitos con prefijo 200 (rango reservado a uso interno en EAN-13) y dígito verificador.
  const base = '200' + String(Date.now()).slice(-9);
  let sum = 0;
  [...base].forEach((d, i) => (sum += Number(d) * (i % 2 ? 3 : 1)));
  $('#artForm').elements.barcode.value = base + ((10 - (sum % 10)) % 10);
});
$('#artForm').addEventListener('submit', guard(async (e) => {
  const body = Object.fromEntries(new FormData(e.target));
  if (editingId) await api('PUT', '/articles/' + editingId, body); else await api('POST', '/articles', body);
  $('#artDialog').close(); toast('Artículo guardado'); await loadArticles();
}));
$('#artTable').addEventListener('click', guard(async (e) => {
  if (e.target.dataset.lbl) { addLabel(window._arts.find((a) => a.id == e.target.dataset.lbl)); showTab('etiquetas'); return; }
  if (e.target.dataset.edit) openArtDialog(window._arts.find((a) => a.id == e.target.dataset.edit));
  if (e.target.dataset.del && confirm('¿Dar de baja este artículo? Se conserva el historial de ventas.')) {
    await api('DELETE', '/articles/' + e.target.dataset.del); await loadArticles();
  }
}));

// ---------- Importar artículos desde Excel ----------
let impPreview = null, impRunning = false;
const impShow = (n) => [1, 2, 3].forEach((i) => ($('#impStep' + i).hidden = i !== n));
const fmt = (n) => Number(n).toLocaleString('es-AR');
const kpi = (label, value, cls = '') => `<div class="kpi"><span>${label}</span><b class="${cls}">${fmt(value)}</b></div>`;
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('No se pudo leer el archivo'));
  r.readAsDataURL(file);
});
$('#artImport').addEventListener('click', () => {
  impPreview = null; $('#impFile').value = ''; $('#impAnalyze').disabled = true; setMsg('impError', '');
  impShow(1); $('#importDialog').showModal();
});
$('#importDialog').addEventListener('cancel', (e) => { if (impRunning) e.preventDefault(); }); // mientras carga no se puede cerrar con Esc
$('#impCancel1').addEventListener('click', () => $('#importDialog').close());
$('#impFile').addEventListener('change', () => { $('#impAnalyze').disabled = !$('#impFile').files.length; setMsg('impError', ''); });
$('#impBack').addEventListener('click', () => { impShow(1); });
$('#impAnalyze').addEventListener('click', async () => {
  const file = $('#impFile').files[0];
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) return setMsg('impError', 'El archivo es demasiado grande (máximo 25 MB).');
  const btn = $('#impAnalyze'); btn.disabled = true; btn.textContent = 'Analizando…'; setMsg('impError', '');
  try {
    impPreview = await api('POST', '/import/preview', { filename: file.name, data: await fileToBase64(file) });
    renderImpPreview();
  } catch (err) { setMsg('impError', err.message); }
  finally { btn.textContent = 'Analizar planilla'; btn.disabled = false; }
});
function renderImpPreview() {
  const p = impPreview;
  $('#impKpis').innerHTML = kpi('Filas leídas', p.totalRows) + kpi('Listas para cargar', p.validRows, 'pos') + kpi('Artículos nuevos', p.newRows) + kpi('Ya existen', p.existingRows) + kpi('Con errores', p.errorCount, p.errorCount ? 'neg' : '');
  const notes = [`Hoja «${esc(p.sheet)}», títulos en la fila ${p.headerRow}.`];
  const missing = p.columns.filter((c) => !c.found).map((c) => c.title);
  if (missing.length) notes.push(`Columnas que no están en la planilla (quedan vacías): ${esc(missing.join(', '))}.`);
  if (p.newBrands.length) notes.push(`Se van a crear estas marcas: <b>${esc(p.newBrands.join(', '))}</b>.`);
  if (p.noCodeRows) notes.push(`${fmt(p.noCodeRows)} fila${p.noCodeRows === 1 ? '' : 's'} sin código de barras.`);
  $('#impInfo').innerHTML = notes.join(' ');
  $('#impErrBox').hidden = !p.errorCount;
  $('#impErrBox').open = p.errorCount > 0 && p.errorCount <= 5;
  $('#impErrSummary').textContent = `${fmt(p.errorCount)} fila${p.errorCount === 1 ? '' : 's'} con errores: no se van a cargar`;
  $('#impErrTable tbody').innerHTML = p.errors.map((e) => `<tr><td>${e.row}</td><td>${esc(e.message)}</td></tr>`).join('');
  $('#impErrMore').textContent = p.errorCount > p.errors.length ? `Se muestran las primeras ${p.errors.length}. Corregí la planilla y volvé a subirla.` : '';
  $('#impModeBox').hidden = !p.existingRows;
  $('#impStart').disabled = !p.validRows;
  $('#impStart').textContent = p.validRows ? `Cargar ${fmt(p.validRows)} artículo${p.validRows === 1 ? '' : 's'}` : 'No hay filas para cargar';
  impShow(2);
}
$('#impStart').addEventListener('click', guard(async () => {
  const st = await api('POST', '/import/start', { token: impPreview.token, mode: $('#impMode').value, genCodes: $('#impGen').checked });
  impRunning = true; $('#impClose').disabled = true; $('#impDone').innerHTML = ''; $('#impMsg').textContent = ''; $('#impMsg').className = '';
  $('#impBar').style.width = '0%'; $('#impCount').textContent = ''; $('#impTitle').textContent = 'Cargando artículos…'; // sin restos de la carga anterior
  impShow(3); renderImpProgress(st); pollImport(st.id);
}));
function renderImpProgress(s) {
  const pct = s.total ? Math.floor((s.done / s.total) * 100) : 100;
  $('#impBar').style.width = pct + '%';
  $('#impCount').textContent = s.state === 'running' ? `Cargando… ${fmt(s.done)} de ${fmt(s.total)} (${pct}%)` : `${fmt(s.done)} de ${fmt(s.total)} (${pct}%)`;
  $('#impTitle').textContent = s.state === 'running' ? 'Cargando artículos…' : s.state === 'done' ? '✔ Carga finalizada' : 'La carga se detuvo';
}
async function pollImport(id) {
  let s;
  try { s = await api('GET', '/import/' + id); }
  catch (err) { impRunning = false; $('#impClose').disabled = false; $('#impTitle').textContent = 'No se pudo ver el avance'; $('#impMsg').textContent = err.message; $('#impMsg').className = 'neg'; return; }
  renderImpProgress(s);
  $('#impDone').innerHTML = kpi('Nuevos', s.created, 'pos') + kpi('Actualizados', s.updated) + kpi('Omitidos', s.skipped) + kpi('Marcas nuevas', s.brandsCreated) + kpi('Filas con errores', s.errorCount, s.errorCount ? 'neg' : '');
  if (s.state === 'running') return setTimeout(() => pollImport(id), 250);
  impRunning = false; $('#impClose').disabled = false;
  const ok = s.state === 'done';
  $('#impMsg').className = ok ? 'pos' : 'neg';
  $('#impMsg').textContent = ok
    ? `Se cargaron ${fmt(s.created)} artículos nuevos y se actualizaron ${fmt(s.updated)}${s.skipped ? `; ${fmt(s.skipped)} ya existían y se dejaron como estaban` : ''}.${s.errorCount ? ` ${fmt(s.errorCount)} filas con errores no se cargaron.` : ''} El sistema ya está actualizado.`
    : s.message;
  if (ok) toast(`Carga finalizada: ${fmt(s.created)} nuevos, ${fmt(s.updated)} actualizados${s.skipped ? `, ${fmt(s.skipped)} omitidos` : ''}`);
  // El sistema se actualiza solo: listado, marcas y datos de stock.
  await guard(loadArticles)();
}
$('#impClose').addEventListener('click', () => $('#importDialog').close());

// ---------- Stock ----------
let adjArticle = null, sbSeq = 0;
const REASON = { inicial: 'Carga inicial', compra: 'Compra', venta: 'Venta', anulacion: 'Anulación de venta', ajuste: 'Ajuste', devolucion: 'Devolución', limpieza: 'Limpieza de stock' };
async function loadStock() {
  const s = await api('GET', '/stock/summary');
  $('#stockSummary').innerHTML = [['Artículos (SKU)', s.skus], ['Unidades', s.units], ['Valor a costo', s.cost_value == null ? '—' : money(s.cost_value)], ['Valor a precio de venta', money(s.retail_value)], ['Con stock bajo', s.low]]
    .map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
  const movs = await api('GET', '/stock/movements');
  $('#movTable tbody').innerHTML = movs.map((m) => `<tr><td>${esc(m.created_at.slice(5, 16))}</td><td>${esc(articleLabel(m))}</td><td class="num ${m.qty < 0 ? 'neg' : 'pos'}">${m.qty > 0 ? '+' : ''}${m.qty}</td><td>${esc(REASON[m.reason] || m.reason)}</td><td>${esc(m.user_name || '')}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">Todavía no hay movimientos</td></tr>';
  const low = await api('GET', '/articles?low=1&limit=500');
  $('#lowTable tbody').innerHTML = low.map((a) => `<tr><td>${esc(a.brand || '—')}</td><td>${esc(a.name)}</td><td>${esc(a.size)}</td><td>${esc(a.color)}</td><td class="num low">${a.stock}</td><td class="num">${a.min_stock}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Todo en orden</td></tr>';
  await loadBrands(); // llena el filtro de marcas de la lista de búsqueda
  await runStockBrowse();
}

// Lista de búsqueda a la derecha del buscador: se filtra mientras se escribe y se elige con un clic.
async function runStockBrowse() {
  const q = $('#adjScan').value.trim(), brand = $('#sbBrand').value, low = $('#sbLow').checked, my = ++sbSeq;
  if (!q && !brand && !low) {
    $('#sbTable tbody').innerHTML = '<tr><td colspan="5" class="muted">Escribí o escaneá a la izquierda, o elegí una marca arriba, para ver los artículos.</td></tr>';
    $('#sbNote').textContent = ''; return;
  }
  const rows = await api('GET', `/articles?q=${encodeURIComponent(q)}${brand ? `&brand_id=${brand}` : ''}${low ? '&low=1' : ''}&limit=300`);
  const total = api.total;
  if (my !== sbSeq) return; // llegó una respuesta de una búsqueda anterior
  window._sb = rows;
  $('#sbTable tbody').innerHTML = rows.map((a) => `<tr data-id="${a.id}" class="${adjArticle?.id === a.id ? 'sel' : ''}"><td>${esc(a.brand || '—')}</td><td>${esc(a.name)}</td><td>${esc(a.size)}</td><td>${esc(a.color)}</td><td class="num ${a.stock <= a.min_stock ? 'low' : ''}">${a.stock}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">No se encontró ningún artículo</td></tr>';
  $('#sbNote').textContent = total > rows.length ? `Mostrando ${rows.length} de ${total}: afiná la búsqueda para ver el resto.` : `${total} artículo${total === 1 ? '' : 's'}. Tocá uno para elegirlo.`;
}
const browseSoon = debounce(guard(runStockBrowse), 200);
$('#adjScan').addEventListener('input', browseSoon);
$('#sbBrand').addEventListener('change', guard(runStockBrowse));
$('#sbLow').addEventListener('change', guard(runStockBrowse));
$('#sbTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && !$('#adjCard').hidden) pickAdj(window._sb.find((a) => a.id == tr.dataset.id));
});
function pickAdj(a) {
  adjArticle = a;
  $('#adjArticle').className = 'adjSel on';
  $('#adjArticle').innerHTML = `<b>${esc(articleLabel(a))}</b><br>Stock actual: <b class="${a.stock <= a.min_stock ? 'low' : ''}">${a.stock}</b>`;
  $$('#sbTable tbody tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id == a.id));
  $('#adjQty').focus(); $('#adjQty').select();
}
function clearAdjSelection() {
  adjArticle = null; $('#adjArticle').className = 'adjSel muted'; $('#adjArticle').textContent = 'Ningún artículo seleccionado. Elegilo en la lista de la derecha.';
}
$('#adjScan').addEventListener('keydown', guard(async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = e.target.value.trim();
  if (!code) return;
  try { pickAdj(await api('GET', '/articles/barcode/' + encodeURIComponent(code))); e.target.value = ''; await runStockBrowse(); }
  catch {
    const list = await api('GET', '/articles?q=' + encodeURIComponent(code));
    if (list.length === 1) { pickAdj(list[0]); e.target.value = ''; await runStockBrowse(); }
    else toast(list.length ? `${list.length} coincidencias: elegí una de la lista` : 'No encontrado', !list.length);
  }
}));
$('#adjForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  if (!adjArticle) throw new Error('Elegí un artículo de la lista');
  const a = await api('POST', '/stock/adjust', { article_id: adjArticle.id, qty: Number($('#adjQty').value), reason: $('#adjReason').value });
  toast(`Stock actualizado: ${articleLabel(a)} → ${a.stock}`);
  // La búsqueda se conserva (con el stock ya actualizado): así se cargan seguidos los demás talles del mismo modelo.
  clearAdjSelection(); $('#adjQty').value = 1; $('#adjScan').focus(); $('#adjScan').select();
  await loadStock();
}));

// Limpiar el stock completo: dos confirmaciones (elegir y confirmar, y escribir la palabra LIMPIAR).
let clrPreview = null;
const clrMode = () => document.querySelector('input[name=clrMode]:checked').value;
const clrShow = (n) => [1, 2, 3].forEach((i) => ($('#clrStep' + i).hidden = i !== n));
$$('input[name=clrMode]').forEach((r) => r.addEventListener('change', () => $$('.opt').forEach((o) => o.classList.toggle('sel', o.querySelector('input').checked))));
$('#stockClear').addEventListener('click', guard(async () => {
  clrPreview = await api('GET', '/stock/clear/preview');
  const p = clrPreview, n = (x) => Number(x).toLocaleString('es-AR');
  $('#clrCounts').textContent = p.total ? `Hay ${n(p.active)} artículos activos con ${n(p.units)} unidades en stock${p.with_sales ? `; ${n(p.with_sales)} tienen ventas registradas` : ''}.` : 'No hay artículos cargados.';
  $('#clrBackup').innerHTML = p.backup ? '✔ Antes de limpiar se hace una copia de seguridad en tu carpeta de copias.'
    : '<span class="neg">⚠ No tenés carpeta de copias configurada (pestaña Copias): después de limpiar no se puede recuperar nada.</span>';
  document.querySelector('input[name=clrMode][value=zero]').checked = true; $$('.opt').forEach((o, i) => o.classList.toggle('sel', i === 0));
  $('#clrNext').disabled = !p.total; clrShow(1); $('#clearDialog').showModal();
}));
$('#clrCancel1').addEventListener('click', () => $('#clearDialog').close());
$('#clrClose').addEventListener('click', () => $('#clearDialog').close());
$('#clrNext').addEventListener('click', () => {
  const p = clrPreview, n = (x) => Number(x).toLocaleString('es-AR');
  $('#clrSummary').textContent = clrMode() === 'zero'
    ? `Vas a dejar en 0 el stock de TODOS los artículos (${n(p.units)} unidades).`
    : `Vas a BORRAR ${n(p.deletable)} artículos${p.with_sales ? ` y dar de baja ${n(p.with_sales)} que tienen ventas` : ''}, junto con todo su stock (${n(p.units)} unidades).`;
  $('#clrWord').value = ''; $('#clrGo').disabled = true; setMsg('clrError', ''); clrShow(2); $('#clrWord').focus();
});
$('#clrBack').addEventListener('click', () => clrShow(1));
$('#clrWord').addEventListener('input', () => { $('#clrGo').disabled = $('#clrWord').value.trim().toUpperCase() !== 'LIMPIAR'; });
$('#clrGo').addEventListener('click', async () => {
  $('#clrGo').disabled = true; setMsg('clrError', '');
  try {
    const r = await api('POST', '/stock/clear', { mode: clrMode(), confirm: $('#clrWord').value });
    const n = (x) => Number(x).toLocaleString('es-AR');
    $('#clrTitle').textContent = '✔ Stock limpio';
    $('#clrResult').textContent = (r.mode === 'zero'
      ? `Se dejó en 0 el stock de ${n(r.zeroed)} artículos (${n(r.units)} unidades).`
      : `Se borraron ${n(r.deleted)} artículos${r.deactivated ? ` y se dieron de baja ${n(r.deactivated)} con ventas` : ''}.`) + (r.backup ? ' Se hizo una copia de seguridad antes.' : '');
    clrShow(3); toast('Stock limpiado');
    await loadStock();
  } catch (err) { setMsg('clrError', err.message); $('#clrGo').disabled = false; }
});

// ---------- Caja ----------
async function loadCash() {
  await refreshCash();
  const operar = can('caja.operar'), ver = can('caja.ver');
  $('#cajaClosed').hidden = !!cash; $('#cajaOpen').hidden = !cash;
  $('#posBox').hidden = !(cash && can('ventas.cobrar')); // sin caja abierta no se vende
  $('#cajaKpis').hidden = !(cash && (ver || operar));
  $('#openForm').hidden = !operar;
  $('#cajaClosed').querySelector('.muted')?.remove();
  if (!cash && !operar) $('#cajaClosed').insertAdjacentHTML('beforeend', '<p class="muted">La caja está cerrada. Pedile a quien tenga permiso que la abra.</p>');
  if (cash) {
    const m = cash.byMethod;
    $('#cajaKpis').hidden = !(ver || operar);
    if (ver || operar) {
      $('#cajaKpis').innerHTML = [
        ['Efectivo esperado en caja', money(cash.expected_cash_now)], ['Fondo inicial', money(cash.opening_amount)],
        ['Efectivo neto', money(m.efectivo.neto)], ['Tarjeta', money(m.tarjeta.neto)], ['Transferencia', money(m.transferencia.neto)],
        ['Ventas', `${cash.sales_count} · ${money(cash.sales_total)}`],
      ].map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
      $('#expected').textContent = `Efectivo esperado: ${money(cash.expected_cash_now)}`;
    }
    $('#cajaOps').hidden = !operar; $('#cajaMovs').hidden = !ver;
    if (ver) {
      const movs = await api('GET', '/cash/movements');
      $('#cashMovTable tbody').innerHTML = movs.map((x) => `<tr><td>${time(x.created_at)}</td><td class="${x.type === 'ingreso' ? 'pos' : 'neg'}">${x.type}</td><td>${x.method}</td><td class="num">${money(x.amount)}</td><td>${esc(x.concept)}</td><td>${esc(x.user_name || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin movimientos</td></tr>';
    }
  }
  const day = $('#salesDate').value || today();
  const sales = await api('GET', '/sales?date=' + day);
  $('#salesTable tbody').innerHTML = sales.map((s) => `<tr style="${s.voided ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${compNumber(s)}</td><td>${time(s.created_at)}</td><td>${esc(s.seller || '')}${s.customer_name ? `<br><small class="muted">Cliente: ${esc(s.customer_name)}</small>` : ''}</td>
    <td>${s.items.map((i) => `${i.qty}× ${esc(i.name)}`).join('<br>')}</td><td>${s.payments.map((p) => `${p.method} ${money(p.amount)}`).join('<br>')}</td>
    <td class="num">${money(s.total)}</td><td><button class="link" data-reprint="${s.id}">Imprimir</button>${s.voided ? 'Anulada' : cash && day === today() && can('ventas.anular') ? `<button class="link" data-void="${s.id}">Anular</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin ventas en esta fecha</td></tr>';
  $('#sessionsBox').hidden = !ver;
  if (ver) {
    const sessions = await api('GET', '/cash/sessions');
    $('#sessionsTable tbody').innerHTML = sessions.map((s) => {
      const d = s.counted_cash == null ? null : s.counted_cash - s.expected_cash;
      return `<tr><td>${s.id}</td><td>${s.opened_at.slice(0, 16)}</td><td>${s.closed_at ? s.closed_at.slice(0, 16) : 'Abierta'}</td><td>${esc([s.opened_by_name, s.closed_by_name].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / '))}</td><td class="num">${money(s.opening_amount)}</td><td class="num">${s.sales_count} · ${money(s.sales_total)}</td>
        <td class="num">${s.closed_at ? money(s.expected_cash) : '—'}</td><td class="num">${s.closed_at ? money(s.counted_cash) : '—'}</td><td class="num ${d < 0 ? 'neg' : d > 0 ? 'pos' : ''}">${d == null ? '—' : money(d)}</td></tr>`;
    }).join('');
  }
  // Con la venta a la vista, el escáner queda listo (salvo que se esté escribiendo en otro campo).
  if (currentTab === 'venta' && !$('#posBox').hidden && !document.activeElement?.matches('input, select, textarea')) $('#scan').focus();
}
$('#openForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await api('POST', '/cash/open', { amount: Number($('#openAmount').value) || 0 });
  toast('Caja abierta'); await loadCash();
}));
$('#movForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await api('POST', '/cash/movement', { type: $('#movType').value, method: $('#movMethod').value, amount: Number($('#movAmount').value), concept: $('#movConcept').value });
  e.target.reset(); toast('Movimiento registrado'); await loadCash();
}));
$('#closeForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  if (!confirm('¿Cerrar la caja? No se podrán registrar ventas hasta abrir una nueva.')) return;
  const r = await api('POST', '/cash/close', { counted: Number($('#closeCounted').value), note: $('#closeNote').value });
  e.target.reset();
  alert(`Caja cerrada.\nEsperado: ${money(r.expected_cash)}\nContado: ${money(r.counted_cash)}\nDiferencia: ${money(r.difference)}`);
  await loadCash();
}));
$('#salesTable').addEventListener('click', guard(async (e) => {
  if (e.target.dataset.reprint) {
    const s = (await api('GET', '/sales?date=' + ($('#salesDate').value || today()))).find((x) => x.id == e.target.dataset.reprint);
    if (s) printTicket(s);
    return;
  }
  if (e.target.dataset.void && confirm('¿Anular la venta? Se devuelve el stock y se registra el egreso en caja.')) {
    await api('POST', `/sales/${e.target.dataset.void}/void`); toast('Venta anulada'); await loadCash();
  }
}));

// ---------- Estadísticas ----------
let group = 'day';
const GROUP_LABEL = { day: 'Ventas por día (últimos 31)', week: 'Ventas por semana (últimas 12)', month: 'Ventas por mes (últimos 12)', year: 'Ventas por año' };
async function loadStats() {
  $('#chartTitle').textContent = GROUP_LABEL[group];
  const [series, br] = await Promise.all([api('GET', '/stats/series?group=' + group), api('GET', '/stats/breakdown?group=' + group)]);
  const tot = series.reduce((a, r) => ({ sales: a.sales + r.sales, total: a.total + r.total, profit: a.profit + (r.profit || 0) }), { sales: 0, total: 0, profit: 0 });
  const showProfit = can('costos.ver');
  $('#statKpis').innerHTML = [[`Período actual (${br.period})`, money(br.total)], ['Ventas del período', br.sales], ['Total mostrado', money(tot.total)], ...(showProfit ? [['Ganancia mostrada', money(tot.profit)]] : [])]
    .map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
  const max = Math.max(1, ...series.map((r) => r.total));
  $('#chart').innerHTML = series.map((r) => `<div class="bar" title="${esc(r.period)}: ${money(r.total)}"><small>${money(r.total).replace(/\s/g, '')}</small><i style="height:${Math.round((r.total / max) * 85)}%"></i><em>${esc(group === 'day' ? r.period.slice(5) : r.period)}</em></div>`).join('') || '<span class="muted">Todavía no hay ventas</span>';
  $('#methodTable tbody').innerHTML = br.byMethod.map((m) => `<tr><td>${esc(m.method)}</td><td class="num">${money(m.total)}</td></tr>`).join('') || '<tr><td class="muted">Sin datos</td></tr>';
  $('#brandStatsTable tbody').innerHTML = br.byBrand.map((r) => `<tr><td>${esc(r.brand)}</td><td class="num">${r.units} u.</td><td class="num">${money(r.total)}</td>${r.profit == null ? '' : `<td class="num">${money(r.profit)} <span class="muted">gan.</span></td>`}</tr>`).join('') || '<tr><td class="muted">Sin datos</td></tr>';
  $('#topTable tbody').innerHTML = br.topArticles.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.units} u.</td><td class="num">${money(t.total)}</td></tr>`).join('') || '<tr><td class="muted">Sin datos</td></tr>';
  $('#seriesTable tbody').innerHTML = [...series].reverse().map((r) => `<tr><td>${esc(r.period)}</td><td class="num">${r.sales}</td><td class="num">${r.units}</td><td class="num">${money(r.total)}</td><td class="num">${money(r.avg_ticket)}</td><td class="num">${r.profit == null ? '—' : money(r.profit)}</td></tr>`).join('');
  $('#sellerTable tbody').innerHTML = br.bySeller.map((v) => `<tr><td>${esc(v.seller)}</td><td class="num">${v.sales} ventas</td><td class="num">${money(v.total)}</td></tr>`).join('') || '<tr><td class="muted">Sin datos</td></tr>';
}
$('#groupSeg').addEventListener('click', guard(async (e) => {
  if (!e.target.dataset.g) return;
  group = e.target.dataset.g;
  $$('#groupSeg button').forEach((b) => b.classList.toggle('active', b === e.target));
  await loadStats();
}));

// ---------- Impresión ----------
const today = () => new Date().toLocaleDateString('sv-SE');
$('#salesDate').value = today();
$('#salesDate').addEventListener('change', guard(() => loadCash()));
const SETTINGS_KEY = 'liuvi.print';
new Image().src = '/img/logo-tinta.png'; // precarga para el ticket
const settings = (() => {
  const d = { name: '', info: '', cuit: '', iva: '', pv: 1, copies: 'both', paper: 'a4', pageSize: 'A4', footer: '¡Gracias por su compra!', auto: false, lblFormat: 'sheet', lblPreset: '60x35', lblW: 60, lblH: 35, lblMargin: 8, lblSkip: 0 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) }; } catch { return d; }
})();
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* sin almacenamiento */ } };
let lastTicket = null;

// Imprime `html` solo (el resto de la página se oculta con CSS) con el tamaño de página indicado.
async function printHtml(html, pageCss) {
  const area = $('#printArea');
  area.innerHTML = html;
  await Promise.all([...area.querySelectorAll('img')].map((i) => i.decode().catch(() => {}))); // el logo tiene que estar cargado al imprimir
  let st = $('#pageStyle');
  if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.append(st); }
  st.textContent = `@page{${pageCss}}`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

const COPIES = { client: ['ORIGINAL · Cliente'], shop: ['DUPLICADO · Comercio'], both: ['ORIGINAL · Cliente', 'DUPLICADO · Comercio'] };
const compNumber = (s) => `${String(settings.pv || 1).padStart(4, '0')}-${String(s.id).padStart(8, '0')}`;
const methodName = (m) => m[0].toUpperCase() + m.slice(1);
const when = (s) => (s.created_at || '').slice(0, 16).replace('T', ' ');

// Ticket para impresora térmica (58/80 mm).
function ticketHtml(s, copy) {
  const w = { 58: '48mm', 80: '72mm' }[settings.paper] || '80mm';
  const row = (a, b, cls = '') => `<div class="r ${cls}"><span>${a}</span><span>${b}</span></div>`;
  const pays = s.payments.map((p) => (p.method === 'efectivo' && s.change
    ? row('Efectivo recibido', money(p.amount + s.change)) + row('Vuelto', money(s.change))
    : row(methodName(p.method), money(p.amount)))).join('');
  return `<div class="ticket" style="width:${w}">
    <img class="logo" src="/img/logo-tinta.png" alt="Liu Vi" style="width:${w === '48mm' ? '30mm' : '40mm'}">
    ${settings.name ? `<div class="c b" style="font-size:14px">${esc(settings.name)}</div>` : ''}
    ${settings.info ? `<div class="c">${esc(settings.info)}</div>` : ''}
    ${settings.cuit ? `<div class="c">CUIT ${esc(settings.cuit)}${settings.iva ? ' · ' + esc(settings.iva) : ''}</div>` : ''}
    <div class="c">${esc(when(s))} · N° ${compNumber(s)}</div>
    ${s.seller ? `<div class="c">Atendió: ${esc(s.seller)}</div>` : ''}
    ${s.customer_name || s.customer_doc ? `<div class="c">Cliente: ${esc([s.customer_name, s.customer_doc].filter(Boolean).join(' · '))}</div>` : ''}
    ${s.voided ? '<div class="c b">*** VENTA ANULADA ***</div>' : ''}
    <hr>
    ${s.items.map((i) => `<div>${esc(i.name)}</div>` + row(`${i.qty} x ${money(i.price)}`, money(i.qty * i.price))).join('')}
    <hr>
    ${s.discount ? row('Subtotal', money(s.subtotal)) + row('Descuento', '-' + money(s.discount)) : ''}
    ${row('TOTAL', money(s.total), 'tot')}
    <hr>${pays}
    <hr><div class="c">${esc(settings.footer)}</div>
    <div class="c" style="font-size:10px">Comprobante no válido como factura</div>
    ${copy ? `<div class="c b" style="font-size:10px">${copy}</div>` : ''}
  </div>`;
}

// Comprobante para hoja A4/Carta. Una copia = una mitad; con pocos artículos entran las dos en la misma hoja.
function comprobanteHtml(s, copy) {
  const pay = s.payments.map((p) => `${methodName(p.method)} ${money(p.amount + (p.method === 'efectivo' ? s.change || 0 : 0))}`).join(' · ');
  return `<div class="comp">
    ${s.voided ? '<div class="stamp">ANULADA</div>' : ''}
    <div class="ch">
      <div class="cl">
        <img src="/img/logo-tinta.png" alt="Liu Vi" style="width:38mm;height:auto">
        ${settings.name ? `<b>${esc(settings.name)}</b>` : ''}
        ${settings.info ? `<div>${esc(settings.info)}</div>` : ''}
        ${settings.cuit ? `<div>CUIT: ${esc(settings.cuit)}</div>` : ''}
        ${settings.iva ? `<div>Condición IVA: ${esc(settings.iva)}</div>` : ''}
      </div>
      <div class="cx"><b>X</b><small>Documento no válido como factura</small></div>
      <div class="cr">
        <b>COMPROBANTE</b>
        <div>N° ${compNumber(s)}</div>
        <div>Fecha: ${esc(when(s))}</div>
        ${s.seller ? `<div>Atendió: ${esc(s.seller)}</div>` : ''}
        <div class="copy">${copy}</div>
      </div>
    </div>
    <div class="cc"><span>Cliente: <b>${esc(s.customer_name || 'Consumidor final')}</b></span>${s.customer_doc ? `<span>DNI/CUIT: <b>${esc(s.customer_doc)}</b></span>` : ''}</div>
    <table><thead><tr><th>Descripción</th><th>Cant.</th><th>Precio unit.</th><th>Subtotal</th></tr></thead><tbody>
      ${s.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="n">${i.qty}</td><td class="n">${money(i.price)}</td><td class="n">${money(i.qty * i.price)}</td></tr>`).join('')}
    </tbody></table>
    <div class="ct">
      ${s.discount ? `<div>Subtotal: ${money(s.subtotal)}</div><div>Descuento: -${money(s.discount)}</div>` : ''}
      <div class="tot">TOTAL: ${money(s.total)}</div>
      <div class="cpay">Pago: ${esc(pay)}${s.change ? ` · Vuelto: ${money(s.change)}` : ''}</div>
    </div>
    <div class="cf">${esc(settings.footer)}</div>
  </div>`;
}
const pageName = () => (settings.pageSize === 'letter' ? 'letter' : 'A4');
const PAGE_MM = () => (settings.pageSize === 'letter' ? [215.9, 279.4] : [210, 297]);
// Térmica: un ticket por copia, cada uno en su tramo de rollo. Común: hoja con el comprobante
// (las dos copias juntas si entran, separadas por una línea de corte; si no, una por hoja).
function printTicket(s) {
  const copies = COPIES[settings.copies] || COPIES.both;
  if (settings.paper === '58' || settings.paper === '80') {
    const html = copies.map((c, i) => `<div${i ? ' class="pb"' : ''}>${ticketHtml(s, c)}</div>`).join('');
    return printHtml(html, `size:${settings.paper}mm auto;margin:3mm`);
  }
  const together = s.items.length <= 10;
  const html = copies.map((c, i) => `${i ? (together ? '<div class="cut">✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>' : '') : ''}<div class="${i && !together ? 'pb' : ''}">${comprobanteHtml(s, c)}</div>`).join('');
  return printHtml(html, `size:${pageName()} portrait;margin:10mm`);
}
$('#lastTicket').addEventListener('click', () => (lastTicket ? printTicket(lastTicket) : toast('Todavía no hay un comprobante para reimprimir', true)));
$('#autoTicket').checked = settings.auto;
$('#autoTicket').addEventListener('change', (e) => { settings.auto = e.target.checked; saveSettings(); });

// Etiquetas
let labels = []; // { a, copies }
function addLabel(a) {
  const l = labels.find((x) => x.a.id === a.id);
  if (l) l.copies++; else labels.push({ a, copies: 1 });
  renderLabels();
}
function renderLabels() {
  $('#lblTable tbody').innerHTML = labels.map((l, i) => `<tr><td>${esc(articleLabel(l.a))}</td>
    <td>${l.a.barcode ? esc(l.a.barcode) : '<span class="low">sin código</span>'}</td>
    <td><input type="number" min="1" max="500" value="${l.copies}" data-copies="${i}" style="width:80px"></td>
    <td><button class="link" data-lrm="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Agregá artículos para imprimir sus etiquetas</td></tr>';
}
$('#lblTable').addEventListener('input', (e) => { if (e.target.dataset.copies) labels[e.target.dataset.copies].copies = Math.max(1, Math.min(500, Number(e.target.value) || 1)); });
$('#lblTable').addEventListener('click', (e) => { if (e.target.dataset.lrm !== undefined) { labels.splice(Number(e.target.dataset.lrm), 1); renderLabels(); } });
$('#lblClear').addEventListener('click', () => { labels = []; renderLabels(); });
$('#lblStock').addEventListener('click', () => { labels.forEach((l) => (l.copies = Math.max(1, l.a.stock))); renderLabels(); });
$('#lblScan').addEventListener('keydown', guard(async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = e.target.value.trim();
  if (!code) return;
  try { addLabel(await api('GET', '/articles/barcode/' + encodeURIComponent(code))); e.target.value = ''; $('#lblResults').innerHTML = ''; }
  catch {
    const list = await searchInto($('#lblResults'), code, (a) => { addLabel(a); $('#lblResults').innerHTML = ''; e.target.value = ''; });
    if (list.length === 1) { addLabel(list[0]); $('#lblResults').innerHTML = ''; e.target.value = ''; }
    else if (!list.length) toast('No encontrado', true);
  }
}));
$('#lblScan').addEventListener('input', debounce(guard(() => {
  const q = $('#lblScan').value.trim();
  return searchInto($('#lblResults'), q, (a) => { addLabel(a); $('#lblResults').innerHTML = ''; $('#lblScan').value = ''; });
})));
function labelHtml(a, w, h) {
  return `<div class="lbl" style="--w:${w}mm;--h:${h}mm">
    <div class="n">${a.brand ? `<span class="b">${esc(a.brand)}</span> ` : ''}${esc(a.name)}</div>
    <div class="t"><span class="s">${esc([a.size && `Talle ${a.size}`, a.color].filter(Boolean).join(' · '))}</span><span class="p">${money(a.price).replace(/,00$/, '')}</span></div>
    <div>${Barcode.svg(a.barcode, { height: Math.max(6, Math.round(h * 0.33)) + 'mm' })}<div class="code">${esc(a.barcode)}</div></div></div>`;
}
// Cuántas etiquetas entran por hoja según medida y margen.
function sheetFit() {
  const [pw, ph] = PAGE_MM();
  const w = Number($('#lblW').value) || 60, h = Number($('#lblH').value) || 35, m = Math.max(0, Number($('#lblMargin').value) || 0);
  return { w, h, m, cols: Math.floor((pw - 2 * m) / w), rows: Math.floor((ph - 2 * m) / h) };
}
function updateFit() {
  const roll = $('#lblFormat').value === 'roll';
  $('#lblMarginBox').hidden = $('#lblSkipBox').hidden = roll;
  const f = sheetFit();
  $('#lblFit').textContent = roll ? 'Una etiqueta por página; configurá el tamaño de papel de tu impresora de etiquetas.'
    : f.cols && f.rows ? `Entran ${f.cols * f.rows} por hoja (${f.cols} columnas × ${f.rows} filas). Se imprimen con borde punteado para recortar.` : 'La etiqueta no entra en la hoja: reducí el tamaño o el margen.';
}
$('#lblPreset').addEventListener('change', () => {
  const v = $('#lblPreset').value;
  if (v !== 'custom') { [$('#lblW').value, $('#lblH').value] = v.split('x'); ['lblW', 'lblH'].forEach((k) => (settings[k] = Number($('#' + k).value))); }
  updateFit();
});
$('#lblPrint').addEventListener('click', guard(async () => {
  if (!labels.length) throw new Error('Agregá al menos un artículo');
  const sinCodigo = labels.filter((l) => !l.a.barcode);
  if (sinCodigo.length) throw new Error(`Sin código de barras: ${sinCodigo.map((l) => l.a.name).join(', ')}. Editá el artículo y usá "Generar".`);
  const roll = $('#lblFormat').value === 'roll';
  const f = sheetFit();
  if (!roll && (!f.cols || !f.rows)) throw new Error('La etiqueta no entra en la hoja: reducí el tamaño o el margen.');
  const skip = roll ? 0 : Math.max(0, Math.floor(Number($('#lblSkip').value) || 0));
  const blanks = Array(skip).fill(`<div class="lbl blank" style="--w:${f.w}mm;--h:${f.h}mm"></div>`);
  const html = [...blanks, ...labels.flatMap((l) => Array(l.copies).fill(labelHtml(l.a, f.w, f.h)))].join('');
  printHtml(roll ? `<div class="roll">${html}</div>` : `<div class="sheet" style="width:${f.cols * f.w}mm">${html}</div>`,
    roll ? `size:${f.w}mm ${f.h}mm;margin:0` : `size:${pageName()} portrait;margin:${f.m}mm`);
}));

// Ajustes
const bindSetting = (id, key) => { const el = $('#' + id); el.value = settings[key]; el.addEventListener('input', () => { settings[key] = el.value; saveSettings(); }); };
bindSetting('setName', 'name'); bindSetting('setInfo', 'info'); bindSetting('setCuit', 'cuit'); bindSetting('setIva', 'iva'); bindSetting('setPv', 'pv'); bindSetting('setCopies', 'copies'); bindSetting('setPaper', 'paper'); bindSetting('setFooter', 'footer'); bindSetting('setPage', 'pageSize');
for (const [id, key] of [['lblFormat', 'lblFormat'], ['lblPreset', 'lblPreset'], ['lblW', 'lblW'], ['lblH', 'lblH'], ['lblMargin', 'lblMargin'], ['lblSkip', 'lblSkip']]) bindSetting(id, key);
['lblFormat', 'lblPreset', 'lblW', 'lblH', 'lblMargin', 'lblSkip', 'setPage'].forEach((id) => $('#' + id).addEventListener('input', updateFit));
// Editar medidas a mano pasa el preset a "Personalizado".
['lblW', 'lblH'].forEach((id) => $('#' + id).addEventListener('input', () => { $('#lblPreset').value = 'custom'; settings.lblPreset = 'custom'; saveSettings(); }));
$('#lblPreset').addEventListener('change', () => { settings.lblPreset = $('#lblPreset').value; saveSettings(); });
updateFit();
$('#testTicket').addEventListener('click', () => printTicket({
  id: 1, created_at: new Date().toLocaleString('sv-SE'), seller: 'Vendedor', customer_name: 'Cliente de prueba', customer_doc: '20-12345678-9', subtotal: 30000, discount: 3000, total: 27000, change: 3000,
  items: [{ name: 'Remera lisa · M · Negro', qty: 2, price: 10000 }, { name: 'Gorra · U', qty: 1, price: 10000 }],
  payments: [{ method: 'efectivo', amount: 27000 }],
}));
function loadPrintTab() { renderLabels(); $('#lblScan').focus(); }

// ---------- Usuarios y roles ----------
let permCatalog = [], rolesCache = [], usersCache = [];
async function loadUsers() {
  [usersCache, rolesCache] = await Promise.all([api('GET', '/users'), api('GET', '/roles')]);
  $('#userTable tbody').innerHTML = usersCache.map((u) => `<tr style="${u.active ? '' : 'opacity:.55'}"><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td><span class="tag">${esc(u.role_name)}</span></td>
    <td>${u.active ? 'Activo' : 'Inactivo'}${u.has_pin ? ' · con PIN' : ''}</td><td><button class="link" data-uedit="${u.id}">Editar</button></td></tr>`).join('');
  renderRoles();
}
const permChecks = (checked, disabled, prefix) => {
  let html = '', group = '';
  for (const p of permCatalog) {
    if (p.group !== group) { group = p.group; html += `<div class="grp">${esc(group)}</div>`; }
    html += `<label class="inline"><input type="checkbox" data-perm="${p.key}" ${checked.includes(p.key) ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${esc(p.label)}</label>`;
  }
  return `<div class="perms" id="${prefix}">${html}</div>`;
};
function renderRoles() {
  $('#roleList').innerHTML = rolesCache.map((r) => `<div class="roleCard" data-role="${r.id}">
    <div class="row"><b style="flex:1">${esc(r.name)}</b><span class="muted">${r.users} usuario${r.users === 1 ? '' : 's'} activo${r.users === 1 ? '' : 's'}</span></div>
    ${r.is_admin ? '<div class="muted">Rol protegido: siempre tiene todos los permisos.</div>' : '<label>Nombre del rol <input data-rname value="' + esc(r.name) + '"></label>'}
    ${permChecks(r.permissions, r.is_admin, 'rp' + r.id)}
    ${r.is_admin ? '' : '<div class="row"><button class="primary" data-rsave>Guardar cambios</button><button class="ghost" data-rdel>Eliminar rol</button></div>'}
  </div>`).join('') + `<div class="roleCard" id="newRoleCard" hidden><b>Nuevo rol</b>
    <label>Nombre del rol <input id="newRoleName" placeholder="Ej: Encargado, Cajero"></label>${permChecks([], false, 'newRolePerms')}
    <div class="row"><button class="primary" id="newRoleSave">Crear rol</button><button class="ghost" id="newRoleCancel">Cancelar</button></div></div>`;
}
const readPerms = (root) => $$('[data-perm]', root).filter((c) => c.checked).map((c) => c.dataset.perm);
$('#roleNew').addEventListener('click', () => { $('#newRoleCard').hidden = false; $('#newRoleName').focus(); });
$('#roleList').addEventListener('click', guard(async (e) => {
  const card = e.target.closest('.roleCard');
  if (e.target.id === 'newRoleCancel') { $('#newRoleCard').hidden = true; return; }
  if (e.target.id === 'newRoleSave') {
    await api('POST', '/roles', { name: $('#newRoleName').value, permissions: readPerms(card) });
    toast('Rol creado'); return loadUsers();
  }
  if (!card?.dataset.role) return;
  if (e.target.dataset.rsave !== undefined) {
    await api('PUT', '/roles/' + card.dataset.role, { name: $('[data-rname]', card).value, permissions: readPerms(card) });
    toast('Rol actualizado: los cambios ya rigen'); return loadUsers();
  }
  if (e.target.dataset.rdel !== undefined && confirm('¿Eliminar este rol?')) { await api('DELETE', '/roles/' + card.dataset.role); toast('Rol eliminado'); return loadUsers(); }
}));
let editingUser = null;
function openUserDialog(u) {
  editingUser = u || null;
  const f = $('#userForm'); f.reset(); $('#userError').textContent = '';
  $('#userTitle').textContent = u ? `Editar ${u.username}` : 'Nuevo usuario';
  f.elements.role_id.innerHTML = rolesCache.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  f.elements.username.disabled = !!u;
  f.elements.password.required = !u;
  $('#userPwLabel').firstChild.textContent = u ? 'Nueva contraseña (dejá vacío para no cambiarla) ' : 'Contraseña (mínimo 8 caracteres) ';
  $('#userActiveBox').hidden = !u;
  $('#userClearPinBox').hidden = !(u && u.has_pin);
  if (u) { f.elements.username.value = u.username; f.elements.name.value = u.name; f.elements.role_id.value = u.role_id; f.elements.active.checked = !!u.active; }
  $('#userDialog').showModal();
}
$('#userNew').addEventListener('click', () => openUserDialog());
$('#userCancel').addEventListener('click', () => $('#userDialog').close());
$('#userTable').addEventListener('click', (e) => { if (e.target.dataset.uedit) openUserDialog(usersCache.find((u) => u.id == e.target.dataset.uedit)); });
$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    if (editingUser) await api('PUT', '/users/' + editingUser.id, { name: f.name.value, role_id: Number(f.role_id.value), active: f.active.checked, clear_pin: f.clear_pin.checked, ...(f.password.value && { password: f.password.value }) });
    else await api('POST', '/users', { username: f.username.value, name: f.name.value, role_id: Number(f.role_id.value), password: f.password.value });
    $('#userDialog').close(); toast('Usuario guardado'); await loadUsers();
  } catch (err) { $('#userError').textContent = err.message; }
});

// ---------- Copias de seguridad ----------
function renderGoogle(g) {
  const box = $('#gdBox');
  if (!g) { box.innerHTML = ''; return; }
  const err = g.error ? `<p class="neg">${esc(g.error)}</p>` : '';
  if (g.connected) {
    box.innerHTML = `<p>✅ Conectado a Google Drive${g.email ? ` como <b>${esc(g.email)}</b>` : ''}.<br>Las copias se suben a la carpeta <b>${esc(g.folder)}</b> de tu Drive.</p>
      <p class="muted">${g.last_at ? `Última subida: <b>${esc(g.last_at)}</b> (${esc(g.last_name)})` : 'Todavía no se subió ninguna copia. Se sube sola con cada copia (una por día y al cerrar la caja).'}</p>${err}
      <div class="row"><button type="button" id="gdRun" class="primary">Hacer copia y subirla ahora</button><button type="button" id="gdOff" class="ghost">Desconectar</button></div>`;
  } else if (g.configured) {
    box.innerHTML = `<p>Conectá la cuenta de Google donde querés guardar las copias. Se abre la página de Google para que inicies sesión y des el permiso (solo accede a lo que crea este sistema).</p>${err}
      <div class="row"><button type="button" id="gdOn" class="primary">Conectar con Google</button>${g.credentials_from === 'propias' ? '<button type="button" id="gdCreds" class="ghost">Cambiar credenciales</button>' : ''}</div>`;
  } else {
    box.innerHTML = `<p>Para conectar tu cuenta hay que cargar una sola vez las credenciales de Google (gratis, se crean en 5 minutos en Google Cloud). Los pasos están en el archivo <b>LEEME-GOOGLE-DRIVE.md</b> de la carpeta del programa.</p>${err}
      <form id="gdCredForm"><label>ID de cliente <input name="id" placeholder="123456-abc.apps.googleusercontent.com" required></label>
      <label>Secreto de cliente <input name="secret" type="password" autocomplete="off" required></label>
      <div id="gdCredErr" class="neg"></div><button class="primary">Guardar credenciales</button></form>`;
  }
}
function renderBackup(b) {
  $('#bkDir').value = b.custom_dir ? b.dir : ''; $('#bkDir').placeholder = b.default_dir || 'C:\\Users\\Mi nombre\\Mi unidad\\Liuvi';
  $('#bkPc').value = b.pc_name || ''; $('#bkAuto').checked = b.auto; $('#bkError').textContent = '';
  renderGoogle(b.google);
  const parts = [];
  if (!b.dir) parts.push('<span class="neg">Sin configurar: todavía no se hacen copias.</span>');
  else parts.push(`Carpeta de esta computadora: <code style="word-break:break-all">${esc(b.dir)}</code>`, b.last_at ? `Última copia: <b>${esc(b.last_at)}</b> (${esc(b.last_reason)})` : 'Todavía no se hizo ninguna copia.');
  if (b.error) parts.push(`<span class="neg">Último error: ${esc(b.error)}</span>`);
  $('#bkStatus').innerHTML = parts.join('<br>');
  $('#bkDbFile').textContent = b.db_file || '';
  $('#bkVersion').textContent = me?.version ? `v${me.version}` : '';
  $('#bkFiles tbody').innerHTML = b.files.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.at)}</td><td class="num">${(f.size / 1024).toFixed(0)} KB</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin copias en la carpeta</td></tr>';
}
async function loadBackup() { renderBackup(await api('GET', '/backup')); }
const bkBody = () => ({ dir: $('#bkDir').value, auto: $('#bkAuto').checked, pc_name: $('#bkPc').value });
$('#bkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { renderBackup(await api('PUT', '/backup', bkBody())); toast('Configuración guardada'); }
  catch (err) { $('#bkError').textContent = err.message; }
});
async function backupNow() {
  try {
    renderBackup(await api('PUT', '/backup', bkBody()));
    toast('Haciendo la copia…');
    renderBackup(await api('POST', '/backup/run', {}));
    toast('Copia realizada');
  } catch (err) { $('#bkError').textContent = err.message; toast(err.message, true); }
}
$('#bkRun').addEventListener('click', backupNow);
$('#gdBox').addEventListener('click', guard(async (e) => {
  const id = e.target.id;
  if (id === 'gdRun') await backupNow();
  if (id === 'gdOn') { const { url } = await api('POST', '/backup/google/start', {}); location.href = url; }
  if (id === 'gdOff' && confirm('¿Desconectar Google Drive? Las copias que ya están en tu Drive no se borran.')) { renderBackup(await api('POST', '/backup/google/disconnect', {})); toast('Google Drive desconectado'); }
  if (id === 'gdCreds') renderGoogle({ configured: false });
}));
$('#gdBox').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try { renderBackup(await api('PUT', '/backup/google/credentials', { client_id: f.id.value, client_secret: f.secret.value })); toast('Credenciales guardadas'); }
  catch (err) { $('#gdCredErr').textContent = err.message; }
});

// ---------- Sesión: acceso, bloqueo, perfil y seguridad ----------
let appReady = false;
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
const recall = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
function showOverlay(which) {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close()); // los diálogos quedarían por encima de la pantalla de acceso
  document.body.classList.add('locked');
  $('#login').hidden = false;
  $('#loginForm').hidden = which !== 'login'; $('#setupForm').hidden = which !== 'setup'; $('#unlockForm').hidden = which !== 'unlock';
}
function showLogin(setup = false) {
  showOverlay(setup ? 'setup' : 'login');
  const f = setup ? $('#setupForm') : $('#loginForm');
  const last = recall('liuvi.lastUser');
  if (!setup && last) { f.elements.username.value = last; f.elements.password.focus(); } else f.elements.username.focus();
}
function showLock(name = me?.user?.name || '') {
  showOverlay('unlock');
  $('#unlockWho').textContent = name ? `Sesión de ${name}. Escribí tu PIN o tu contraseña para seguir.` : 'Escribí tu PIN o tu contraseña para seguir.';
  $('#unlockError').textContent = '';
  const f = $('#unlockForm'); f.elements.secret.value = ''; f.elements.secret.focus();
}
function hideOverlay() { $('#login').hidden = true; document.body.classList.remove('locked'); lastActivity = Date.now(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements; $('#loginError').textContent = '';
  try { await api('POST', '/auth/login', { username: f.username.value, password: f.password.value }); remember('liuvi.lastUser', f.username.value.trim()); location.reload(); }
  catch (err) { $('#loginError').textContent = err.message; f.password.value = ''; f.password.focus(); }
});
$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements; $('#setupError').textContent = '';
  if (f.password.value !== f.password2.value) { $('#setupError').textContent = 'Las contraseñas no coinciden'; return; }
  try { await api('POST', '/auth/setup', { name: f.name.value, username: f.username.value, password: f.password.value }); remember('liuvi.lastUser', f.username.value.trim()); location.reload(); }
  catch (err) { $('#setupError').textContent = err.message; }
});
$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements; $('#unlockError').textContent = '';
  try {
    await api('POST', '/auth/unlock', { secret: f.secret.value });
    f.secret.value = '';
    if (!appReady) return location.reload(); // la página se abrió ya bloqueada: falta arrancar la pantalla
    hideOverlay(); guard(loaders[currentTab])(); // se sigue donde se estaba (la venta en curso no se pierde)
  } catch (err) { $('#unlockError').textContent = err.message; f.secret.value = ''; f.secret.focus(); }
});
$('#unlockOther').addEventListener('click', async () => { await api('POST', '/auth/logout', {}).catch(() => {}); location.reload(); });
$('#logoutBtn').addEventListener('click', async () => { await api('POST', '/auth/logout', {}).catch(() => {}); location.reload(); });
async function lockNow() { await api('POST', '/auth/lock', {}).catch(() => {}); showLock(); }
$('#lockBtn').addEventListener('click', lockNow);
$('#profileLock').addEventListener('click', lockNow);

// Perfil y seguridad: se abre al hacer clic en el nombre de arriba.
const setMsg = (id, text, ok = false) => { const el = $('#' + id); el.textContent = text; el.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : ''); };
function renderPinStatus() {
  const has = !!me.user.hasPin;
  $('#pinStatus').textContent = has
    ? 'Tenés un PIN. Podés usarlo en lugar de la contraseña para entrar y para desbloquear (solo desde esta computadora). Para cambiarlo, guardá uno nuevo.'
    : 'Todavía no tenés PIN. Con uno de 4 a 8 números entrás y desbloqueás más rápido, como en Windows.';
  $('#pinRemove').hidden = !has;
  $('#pinSave').textContent = has ? 'Cambiar PIN' : 'Guardar PIN';
}
$('#profileBtn').addEventListener('click', guard(async () => {
  $('#profileInfo').textContent = `${me.user.name} · usuario «${me.user.username}» · ${me.user.role}`;
  for (const id of ['pwForm', 'pinForm']) $('#' + id).reset();
  for (const id of ['pwMsg', 'pinMsg', 'secMsg']) setMsg(id, '');
  renderPinStatus();
  const admin = can('usuarios.admin');
  $('#secAdmin').hidden = !admin;
  if (admin) { const sec = await api('GET', '/security'); $('#secLoginOnStart').checked = sec.loginOnStart; $('#secIdle').value = String(sec.idleLockMinutes); }
  $('#profileDialog').showModal();
}));
$('#profileClose').addEventListener('click', () => $('#profileDialog').close());
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (f.next.value !== f.next2.value) return setMsg('pwMsg', 'Las contraseñas nuevas no coinciden');
  try { await api('POST', '/auth/password', { current: f.current.value, next: f.next.value }); e.target.reset(); setMsg('pwMsg', 'Contraseña cambiada. Las demás sesiones abiertas se cerraron.', true); }
  catch (err) { setMsg('pwMsg', err.message); }
});
$('#pinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (f.pin.value !== f.pin2.value) return setMsg('pinMsg', 'Los PIN no coinciden');
  try { await api('POST', '/auth/pin', { current: f.current.value, pin: f.pin.value }); me.user.hasPin = true; e.target.reset(); renderPinStatus(); setMsg('pinMsg', 'PIN guardado. Ya podés usarlo para entrar y desbloquear.', true); }
  catch (err) { setMsg('pinMsg', err.message); }
});
$('#pinRemove').addEventListener('click', async () => {
  const f = $('#pinForm').elements;
  if (!f.current.value) return setMsg('pinMsg', 'Escribí tu contraseña actual para quitar el PIN');
  try { await api('POST', '/auth/pin/remove', { current: f.current.value }); me.user.hasPin = false; $('#pinForm').reset(); renderPinStatus(); setMsg('pinMsg', 'PIN quitado.', true); }
  catch (err) { setMsg('pinMsg', err.message); }
});
$('#secForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const sec = await api('PUT', '/security', { loginOnStart: $('#secLoginOnStart').checked, idleLockMinutes: Number($('#secIdle').value) });
    me.security = sec; startIdleWatch(); setMsg('secMsg', 'Seguridad guardada.', true);
  } catch (err) { setMsg('secMsg', err.message); }
});

// Bloqueo automático por inactividad: el navegador cuenta la actividad (mouse, teclado, lector) y avisa al servidor.
let lastActivity = Date.now(), lastPing = 0, idleTimer = null;
['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
function startIdleWatch() {
  clearInterval(idleTimer);
  const min = me?.security?.idleLockMinutes || 0;
  if (!min) return;
  idleTimer = setInterval(async () => {
    if (!$('#login').hidden) return; // ya está bloqueado
    const idle = Date.now() - lastActivity;
    if (idle >= min * 60_000) return lockNow();
    if (idle < 60_000 && Date.now() - lastPing > 60_000) { lastPing = Date.now(); api('POST', '/auth/ping', {}).catch((e) => { if (e.locked) showLock(); }); }
  }, 15_000);
}

// ---------- Inicio ----------
async function boot() {
  me = await api('GET', '/auth/me');
  permCatalog = me.permissions;
  // Si el HTML quedó guardado de una versión anterior, se recarga una vez para traer la actual.
  const pageVersion = document.querySelector('meta[name=liuvi-version]')?.content;
  if (pageVersion && me.version && pageVersion !== me.version && sessionStorage.getItem('liuvi.reloaded') !== me.version) {
    try { sessionStorage.setItem('liuvi.reloaded', me.version); } catch { /* sin almacenamiento */ }
    return location.reload();
  }
  $('#footVer').textContent = `Liu Vi v${me.version}`;
  $('#verInfo').textContent = `Liu Vi v${me.version}`;
  if (me.setupNeeded && me.dbFile) $('#setupDb').textContent = `No hay ningún usuario en esta base de datos (${me.dbFile}). Si ya habías creado usuarios, es posible que estés abriendo una versión vieja o otra copia del programa.`;
  if (me.locked) return showLock(me.lockedName); // la sesión sigue abierta pero bloqueada
  if (!me.user) return showLogin(me.setupNeeded);
  $('#login').hidden = true; document.body.classList.remove('locked');
  $('#userName').textContent = me.user.name; $('#userRole').textContent = `(${me.user.role})`;
  appReady = true; startIdleWatch();
  document.body.classList.toggle('nocost', !can('costos.ver'));
  $('#adjCard').hidden = !can('stock.ajustar');
  $('#clearCard').hidden = !can('stock.limpiar');
  $('#artNew').hidden = $('#artImport').hidden = !can('articulos.editar');
  let first = null;
  $$('#tabs button').forEach((b) => { const ok = canAny(...TAB_PERMS[b.dataset.tab]); b.hidden = !ok; if (ok && !first) first = b.dataset.tab; });
  renderCart();
  if (!first) return toast('Tu usuario no tiene permisos asignados. Pedile a un administrador que configure tu rol.', true);
  await guard(refreshCash)();
  const wanted = location.hash.slice(1);
  showTab(wanted && TAB_PERMS[wanted] && canAny(...TAB_PERMS[wanted]) ? wanted : first);
  if (wanted) history.replaceState(null, '', location.pathname);
}
boot().catch((e) => toast(e.message, true));
