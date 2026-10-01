const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(n || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (s) => s.slice(11, 16);

async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Error de servidor');
  return data;
}
let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (error ? ' error' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const articleLabel = (a) => [a.name, a.size && `Talle ${a.size}`, a.color].filter(Boolean).join(' · ');

// ---------- Pestañas ----------
let currentTab = 'venta';
const loaders = { venta: () => {}, articulos: loadArticles, stock: loadStock, caja: loadCash, stats: loadStats };
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
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) || $('dialog[open]')) return;
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
  cart = []; $('#discount').value = 0;
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
  const sale = await api('POST', '/sales', { items: cart.map((l) => ({ article_id: l.a.id, qty: l.qty })), discount_pct: Number($('#discount').value) || 0, payments });
  toast(`Venta #${sale.id} registrada${sale.change ? ` · Vuelto ${money(sale.change)}` : ''}`);
  resetSale(); await refreshCash();
}));

// ---------- Artículos ----------
async function loadArticles() {
  const q = encodeURIComponent($('#artSearch').value.trim());
  const rows = await api('GET', `/articles?q=${q}&low=${$('#artLow').checked ? 1 : 0}`);
  $('#artTable tbody').innerHTML = rows.map((a) => `
    <tr><td>${esc(a.barcode || '—')}</td><td>${esc(a.name)}</td><td>${esc(a.category)}</td><td>${esc(a.size)}</td><td>${esc(a.color)}</td>
    <td class="num">${money(a.price)}</td><td class="num">${money(a.cost)}</td>
    <td class="num ${a.stock <= a.min_stock ? 'low' : ''}">${a.stock}</td>
    <td><button class="link" data-edit="${a.id}">Editar</button><button class="link" data-del="${a.id}">Baja</button></td></tr>`).join('')
    || '<tr><td colspan="9" class="muted">Sin artículos</td></tr>';
  window._arts = rows;
  const cats = await api('GET', '/articles');
  $('#cats').innerHTML = [...new Set(cats.map((a) => a.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('');
}
$('#artSearch').addEventListener('input', debounce(guard(loadArticles)));
$('#artLow').addEventListener('change', guard(loadArticles));
let editingId = null;
function openArtDialog(a) {
  editingId = a?.id ?? null;
  const f = $('#artForm');
  f.reset();
  $('#artTitle').textContent = a ? 'Editar artículo' : 'Nuevo artículo';
  $('#stockInitial').hidden = !!a;
  for (const k of ['barcode', 'name', 'category', 'size', 'color', 'price', 'cost', 'min_stock']) if (a) f.elements[k].value = a[k] ?? '';
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
  if (e.target.dataset.edit) openArtDialog(window._arts.find((a) => a.id == e.target.dataset.edit));
  if (e.target.dataset.del && confirm('¿Dar de baja este artículo? Se conserva el historial de ventas.')) {
    await api('DELETE', '/articles/' + e.target.dataset.del); await loadArticles();
  }
}));

// ---------- Stock ----------
let adjArticle = null;
async function loadStock() {
  const s = await api('GET', '/stock/summary');
  $('#stockSummary').innerHTML = [['Artículos (SKU)', s.skus], ['Unidades', s.units], ['Valor a costo', money(s.cost_value)], ['Valor a precio de venta', money(s.retail_value)], ['Con stock bajo', s.low]]
    .map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
  const movs = await api('GET', '/stock/movements');
  $('#movTable tbody').innerHTML = movs.map((m) => `<tr><td>${esc(m.created_at.slice(5, 16))}</td><td>${esc(articleLabel(m))}</td><td class="num ${m.qty < 0 ? 'neg' : 'pos'}">${m.qty > 0 ? '+' : ''}${m.qty}</td><td>${esc(m.reason)}</td></tr>`).join('');
  const low = await api('GET', '/articles?low=1');
  $('#lowTable tbody').innerHTML = low.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.size)}</td><td>${esc(a.color)}</td><td class="low">${a.stock}</td><td>${a.min_stock}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Todo en orden</td></tr>';
}
function pickAdj(a) { adjArticle = a; $('#adjArticle').textContent = `${articleLabel(a)} — stock actual: ${a.stock}`; $('#adjQty').focus(); $('#adjQty').select(); }
$('#adjScan').addEventListener('keydown', guard(async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = e.target.value.trim();
  if (!code) return;
  try { pickAdj(await api('GET', '/articles/barcode/' + encodeURIComponent(code))); }
  catch {
    const list = await api('GET', '/articles?q=' + encodeURIComponent(code));
    if (list.length === 1) pickAdj(list[0]); else toast(list.length ? `${list.length} coincidencias: afiná la búsqueda o escaneá el código` : 'No encontrado', true);
  }
  e.target.value = '';
}));
$('#adjForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  if (!adjArticle) throw new Error('Elegí un artículo');
  const a = await api('POST', '/stock/adjust', { article_id: adjArticle.id, qty: Number($('#adjQty').value), reason: $('#adjReason').value });
  toast(`Stock actualizado: ${a.stock}`);
  adjArticle = null; $('#adjArticle').textContent = 'Ningún artículo seleccionado'; $('#adjScan').focus();
  await loadStock();
}));

// ---------- Caja ----------
async function loadCash() {
  await refreshCash();
  $('#cajaClosed').hidden = !!cash; $('#cajaOpen').hidden = !cash;
  if (cash) {
    const m = cash.byMethod;
    $('#cajaKpis').innerHTML = [
      ['Efectivo esperado en caja', money(cash.expected_cash_now)], ['Fondo inicial', money(cash.opening_amount)],
      ['Efectivo neto', money(m.efectivo.neto)], ['Tarjeta', money(m.tarjeta.neto)], ['Transferencia', money(m.transferencia.neto)],
      ['Ventas', `${cash.sales_count} · ${money(cash.sales_total)}`],
    ].map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
    $('#expected').textContent = `Efectivo esperado: ${money(cash.expected_cash_now)}`;
    const movs = await api('GET', '/cash/movements');
    $('#cashMovTable tbody').innerHTML = movs.map((x) => `<tr><td>${time(x.created_at)}</td><td class="${x.type === 'ingreso' ? 'pos' : 'neg'}">${x.type}</td><td>${x.method}</td><td class="num">${money(x.amount)}</td><td>${esc(x.concept)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sin movimientos</td></tr>';
  }
  const sales = await api('GET', '/sales');
  $('#salesTable tbody').innerHTML = sales.map((s) => `<tr style="${s.voided ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${s.id}</td><td>${time(s.created_at)}</td>
    <td>${s.items.map((i) => `${i.qty}× ${esc(i.name)}`).join('<br>')}</td><td>${s.payments.map((p) => `${p.method} ${money(p.amount)}`).join('<br>')}</td>
    <td class="num">${money(s.total)}</td><td>${s.voided ? 'Anulada' : cash ? `<button class="link" data-void="${s.id}">Anular</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin ventas hoy</td></tr>';
  const sessions = await api('GET', '/cash/sessions');
  $('#sessionsTable tbody').innerHTML = sessions.map((s) => {
    const d = s.counted_cash == null ? null : s.counted_cash - s.expected_cash;
    return `<tr><td>${s.id}</td><td>${s.opened_at.slice(0, 16)}</td><td>${s.closed_at ? s.closed_at.slice(0, 16) : 'Abierta'}</td><td class="num">${money(s.opening_amount)}</td><td class="num">${s.sales_count} · ${money(s.sales_total)}</td>
      <td class="num">${s.closed_at ? money(s.expected_cash) : '—'}</td><td class="num">${s.closed_at ? money(s.counted_cash) : '—'}</td><td class="num ${d < 0 ? 'neg' : d > 0 ? 'pos' : ''}">${d == null ? '—' : money(d)}</td></tr>`;
  }).join('');
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
  const tot = series.reduce((a, r) => ({ sales: a.sales + r.sales, total: a.total + r.total, profit: a.profit + r.profit }), { sales: 0, total: 0, profit: 0 });
  $('#statKpis').innerHTML = [[`Período actual (${br.period})`, money(br.total)], ['Ventas del período', br.sales], ['Total mostrado', money(tot.total)], ['Ganancia mostrada', money(tot.profit)]]
    .map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
  const max = Math.max(1, ...series.map((r) => r.total));
  $('#chart').innerHTML = series.map((r) => `<div class="bar" title="${esc(r.period)}: ${money(r.total)}"><small>${money(r.total).replace(/\s/g, '')}</small><i style="height:${Math.round((r.total / max) * 85)}%"></i><em>${esc(group === 'day' ? r.period.slice(5) : r.period)}</em></div>`).join('') || '<span class="muted">Todavía no hay ventas</span>';
  $('#methodTable tbody').innerHTML = br.byMethod.map((m) => `<tr><td>${esc(m.method)}</td><td class="num">${money(m.total)}</td></tr>`).join('') || '<tr><td class="muted">Sin datos</td></tr>';
  $('#topTable tbody').innerHTML = br.topArticles.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.units} u.</td><td class="num">${money(t.total)}</td></tr>`).join('') || '<tr><td class="muted">Sin datos</td></tr>';
  $('#seriesTable tbody').innerHTML = [...series].reverse().map((r) => `<tr><td>${esc(r.period)}</td><td class="num">${r.sales}</td><td class="num">${r.units}</td><td class="num">${money(r.total)}</td><td class="num">${money(r.avg_ticket)}</td><td class="num">${money(r.profit)}</td></tr>`).join('');
}
$('#groupSeg').addEventListener('click', guard(async (e) => {
  if (!e.target.dataset.g) return;
  group = e.target.dataset.g;
  $$('#groupSeg button').forEach((b) => b.classList.toggle('active', b === e.target));
  await loadStats();
}));

// ---------- Inicio ----------
renderCart();
guard(refreshCash)();
