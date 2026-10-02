const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(n || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (s) => s.slice(11, 16);

async function api(method, path, body) {
  let res;
  try { res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('No se pudo comunicar con Liu Vi. Si se cerró el programa, volvé a abrirlo desde el acceso directo.'); }
  const data = await res.json().catch(() => null);
  api.total = res.headers.get('X-Total-Count') === null ? null : Number(res.headers.get('X-Total-Count')); // total real de un listado
  if (res.status === 401 && !path.startsWith('/auth/')) { if (data?.locked) showLock(); else showLogin(); }
  if (!res.ok) { const err = new Error(data?.error || 'Error de servidor'); err.locked = !!data?.locked; throw err; }
  return data;
}
// Cuadros de diálogo propios (reemplazan los de «localhost dice» del navegador).
// buttons: [{ label, value, kind: 'primary' | 'ghost' | 'danger' }]; el primero con primary:true responde al Enter. Esc = cancelar.
function ask({ title = 'Liu Vi', text = '', input = null, buttons, stack = false }) {
  return new Promise((resolve) => {
    const d = $('#uiDialog'), box = $('#uiButtons'), inp = $('#uiInput');
    $('#uiTitle').textContent = title; $('#uiText').textContent = text;
    inp.hidden = input === null; inp.value = input ?? '';
    box.className = 'row end' + (stack ? ' stack' : '');
    box.innerHTML = '';
    const cancelValue = (buttons.find((b) => b.cancel) || buttons.at(-1)).value;
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button'; el.textContent = b.label; el.className = b.kind || 'ghost'; if (b.kind === 'danger') el.classList.add('danger');
      el.addEventListener('click', () => finish(input !== null && b.value === true ? inp.value : b.value));
      box.append(el);
    }
    d.oncancel = (e) => { e.preventDefault(); finish(input !== null ? null : cancelValue); };
    d.onkeydown = (e) => { if (e.key === 'Enter' && !e.target.matches('button')) { e.preventDefault(); const p = box.querySelector('.primary, .danger'); if (p) p.click(); } };
    d.showModal();
    (input !== null ? inp : box.querySelector('.primary, .danger') || box.firstChild).focus();
    if (input !== null) inp.select();
  });
}
const uiConfirm = (text, { title = 'Liu Vi', ok = 'Aceptar', cancel = 'Cancelar', danger = false } = {}) =>
  ask({ title, text, buttons: [{ label: ok, value: true, kind: danger ? 'danger' : 'primary' }, { label: cancel, value: false, kind: 'ghost', cancel: true }] });
const uiAlert = (text, title = 'Liu Vi') => ask({ title, text, buttons: [{ label: 'Aceptar', value: true, kind: 'primary' }] });
const uiPrompt = (text, def = '', { title = 'Liu Vi', ok = 'Aceptar' } = {}) =>
  ask({ title, text, input: def, buttons: [{ label: ok, value: true, kind: 'primary' }, { label: 'Cancelar', value: null, kind: 'ghost', cancel: true }] });
let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (error ? ' error' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3000);
}
let me = null; // { user, permissions } de la sesión
const can = (p) => !!me?.user?.permissions.includes(p);
const canAny = (...ps) => ps.some(can);
// Cualquier error que no se haya atrapado se avisa con calma en vez de dejar la pantalla trabada.
let lastErrToast = 0;
const softFail = (e) => { console.error(e); if (Date.now() - lastErrToast > 4000) { lastErrToast = Date.now(); try { toast('Algo no salió bien. Probá de nuevo; si sigue, avisá al administrador.', true); } catch { /* sin pantalla */ } } };
window.addEventListener('error', (ev) => softFail(ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => { ev.preventDefault(); softFail(ev.reason); });
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const avail = (a) => a.stock - (a.reserved || 0); // lo apartado con seña no se puede vender a otro
const articleLabel = (a) => [a.brand, a.name, a.size && `Talle ${a.size}`, a.color].filter(Boolean).join(' · ');

// ---------- Pestañas ----------
let currentTab = 'venta';
const loaders = { inicio: loadDashboard, proveedores: loadSuppliers, reportes: loadReports, venta: loadCash, clientes: loadCustomers, etiquetas: loadPrintTab, articulos: loadArticles, stock: loadStock, stats: loadStats, usuarios: loadUsers, copias: loadBackup };
const TAB_PERMS = { inicio: ['estadisticas.ver', 'caja.ver'], venta: ['ventas.cobrar', 'caja.ver', 'caja.operar'], clientes: ['clientes.ver'], articulos: ['articulos.ver'], etiquetas: ['articulos.ver'], stock: ['stock.ver'], proveedores: ['proveedores.ver'], stats: ['estadisticas.ver'], reportes: ['estadisticas.ver', 'caja.ver', 'stock.ver', 'clientes.ver'], usuarios: ['usuarios.admin'], copias: ['sistema.copias'] };
// Dos niveles: «Inventario» (Artículos, Stock, Proveedores) y «Reportes y estadísticas» (Estadísticas, Reportes) agrupan sus secciones.
const GROUPS = { inventario: ['articulos', 'stock', 'proveedores'], reportes: ['stats', 'reportes'] };
const groupOf = (tab) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(tab)) || null;
const tabAllowed = (tab) => !!TAB_PERMS[tab] && canAny(...TAB_PERMS[tab]);
const lastInGroup = {};
function showTab(name) {
  currentTab = name;
  const group = groupOf(name);
  if (group) lastInGroup[group] = name;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name || (!!group && b.dataset.group === group)));
  $$('#subTabs button').forEach((b) => { b.hidden = b.dataset.in !== group || (b.dataset.need ? !can(b.dataset.need) : !tabAllowed(b.dataset.tab)); b.classList.toggle('active', b.dataset.tab === name); });
  $('#subTabs').hidden = !group;
  $$('.tab').forEach((s) => (s.hidden = s.id !== name));
  guard(loaders[name])();
  if (name === 'venta') { $('#scan').focus(); refreshOffers(); }
}
// Qué sección abre cada botón de la barra principal (el último grupo visitado recuerda su sección).
const tabOfButton = (b) => (b.dataset.tab ? (tabAllowed(b.dataset.tab) ? b.dataset.tab : null) : (lastInGroup[b.dataset.group] && tabAllowed(lastInGroup[b.dataset.group]) ? lastInGroup[b.dataset.group] : GROUPS[b.dataset.group].find(tabAllowed)));
$('#subTabs').addEventListener('click', (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); const t = b && tabOfButton(b); if (t) showTab(t); });

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
// Descuento y recargo, cada uno por porcentaje o por monto. El descuento va sobre el subtotal; el recargo, sobre lo que queda.
const adj = { dType: 'pct', sType: 'pct' };
const r2 = (n) => Math.round(n * 100) / 100;
const adjustBody = () => {
  const d = Math.max(0, Number($('#discVal').value) || 0), sv = Math.max(0, Number($('#sureVal').value) || 0);
  return { discount_pct: adj.dType === 'pct' ? d : 0, discount_amount: adj.dType === 'amt' ? d : 0, surcharge_pct: adj.sType === 'pct' ? sv : 0, surcharge_amount: adj.sType === 'amt' ? sv : 0 };
};
function setAdjust(a = {}) {
  const d = a.discount_amount > 0 ? ['amt', a.discount_amount] : ['pct', a.discount_pct || 0];
  const sv = a.surcharge_amount > 0 ? ['amt', a.surcharge_amount] : ['pct', a.surcharge_pct || 0];
  adj.dType = d[0]; adj.sType = sv[0];
  $('#discVal').value = d[1] || ''; $('#sureVal').value = sv[1] || '';
  for (const [id, t] of [['#discType', adj.dType], ['#sureType', adj.sType]]) $$(id + ' button').forEach((b) => b.classList.toggle('active', b.dataset.t === t));
}
const hasAdjust = () => { const a = adjustBody(); return a.discount_pct + a.discount_amount + a.surcharge_pct + a.surcharge_amount > 0; };
// Ofertas vigentes (las manda el servidor; el cálculo es el mismo en los dos lados). Se refrescan al abrir la venta y cada tanto.
let offers = [], offersAt = 0;
async function refreshOffers(force = false) {
  if (!force && Date.now() - offersAt < 60_000) return;
  try { offers = await api('GET', '/promotions/active'); offersAt = Date.now(); renderCart(); } catch { /* sin permiso o sin conexión: se vende sin ofertas */ }
}
const cartPromo = () => (cart.length && offers.length ? Promo.apply(offers, cart.map((l) => ({ article_id: l.a.id, price: l.a.price, qty: l.qty }))) : { total: 0, detail: [] });
const cartTotals = () => {
  const subtotal = r2(cart.reduce((s, l) => s + l.a.price * l.qty, 0));
  const promo = cartPromo();
  const afterPromo = r2(subtotal - promo.total);
  const a = adjustBody();
  const manual = Math.min(afterPromo, a.discount_amount > 0 ? a.discount_amount : r2(afterPromo * Math.min(100, a.discount_pct) / 100));
  const base = r2(afterPromo - manual);
  const surcharge = a.surcharge_amount > 0 ? a.surcharge_amount : r2(base * Math.min(100, a.surcharge_pct) / 100);
  return { subtotal, promo, discount: manual, surcharge, total: r2(base + surcharge) };
};
function renderCart() {
  $('#cart tbody').innerHTML = cart.map((l, i) => `
    <tr><td>${esc(articleLabel(l.a))}</td>
    <td><button class="link" data-q="${i}:-1">−</button> ${l.qty} <button class="link" data-q="${i}:1">+</button></td>
    <td class="num">${money(l.a.price)}</td><td class="num">${money(l.a.price * l.qty)}</td>
    <td><button class="link" data-rm="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Escaneá un artículo para empezar</td></tr>';
  const { subtotal, promo, discount, surcharge, total } = cartTotals();
  $('#subtotal').textContent = money(subtotal);
  $('#promoLine').hidden = !(promo.total > 0); $('#promoShow').textContent = '− ' + money(promo.total);
  $('#promoShow').title = promo.detail.map((d) => `${d.name}: ${money(d.amount)}`).join('\n');
  $('#promoLabel').textContent = promo.detail.length === 1 ? `Oferta: ${promo.detail[0].name}` : 'Ofertas';
  $('#discLine').hidden = !(discount > 0); $('#discShow').textContent = '− ' + money(discount);
  $('#sureLine').hidden = !(surcharge > 0); $('#sureShow').textContent = '+ ' + money(surcharge);
  $('#total').textContent = money(total);
  updateChange();
}

// Cobro: una o más líneas «medio + monto». La última línea sin monto cobra lo que falta.
const PAY_LABEL = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cuenta: 'Saldo / cuenta del cliente' };
let payLines = [{ method: 'efectivo', amount: '' }];
function renderPayLines() {
  const methods = ['efectivo', 'tarjeta', 'transferencia', ...(saleCustomer?.id ? ['cuenta'] : [])];
  for (const l of payLines) if (!methods.includes(l.method)) l.method = 'efectivo'; // se quitó el cliente: ya no hay cuenta
  $('#payLines').innerHTML = payLines.map((l, i) => `<div class="payLine">
    <select data-pm="${i}" aria-label="Medio de pago">${methods.map((m) => `<option value="${m}"${m === l.method ? ' selected' : ''}>${PAY_LABEL[m]}</option>`).join('')}</select>
    <input data-pa="${i}" type="number" min="0" step="0.01" inputmode="decimal" value="${l.amount}" aria-label="Monto">
    ${payLines.length > 1 ? `<span class="payAct"><button type="button" class="link" data-prest="${i}" title="Poner en este medio lo que falta">Resto</button><button type="button" class="link" data-prm="${i}" title="Quitar">✕</button></span>` : '<span></span>'}</div>`).join('');
  updateChange();
}
// Con un solo medio y sin monto se cobra el total. Con varios medios cada monto es explícito (vacío = 0) para ver cuánto falta.
function effectivePays() {
  const total = cartTotals().total;
  const typed = payLines.map((l) => Math.max(0, Number(l.amount) || 0));
  if (payLines.length === 1) return [{ method: payLines[0].method, amount: typed[0] || total }];
  return payLines.map((l, i) => ({ method: l.method, amount: typed[i] }));
}
const paymentsEntered = () => effectivePays().filter((p) => p.method !== 'cuenta' && p.amount > 0);
const accountEntered = () => (saleCustomer?.id ? r2(effectivePays().filter((p) => p.method === 'cuenta').reduce((sum, p) => sum + p.amount, 0)) : 0);
function setPayLines(lines) { payLines = lines.length ? lines : [{ method: 'efectivo', amount: '' }]; renderPayLines(); }
function updateChange() {
  const { total } = cartTotals();
  const eff = effectivePays();
  const paid = r2(eff.reduce((sum, p) => sum + p.amount, 0)), diff = r2(paid - total);
  const hasCash = eff.some((p) => p.method === 'efectivo' && p.amount > 0);
  // El monto que se va a cobrar se ve en gris dentro de la última línea mientras no se escribe otro.
  $$('#payLines input[data-pa]').forEach((inp) => { inp.placeholder = payLines.length === 1 ? String(eff[0]?.amount || 0) : '0'; });
  const st = $('#payStatus');
  if (!cart.length) { st.className = 'payStatus'; st.textContent = ''; }
  else if (diff < 0) { st.className = 'payStatus falta'; st.textContent = `Falta cobrar ${money(-diff)}`; }
  else if (diff > 0) { st.className = 'payStatus ' + (hasCash ? 'vuelto' : 'falta'); st.textContent = hasCash ? `Vuelto ${money(diff)}` : `El pago supera el total en ${money(diff)}`; }
  else { st.className = 'payStatus ok'; st.textContent = 'Pago completo ✓'; }
  $('#charge').textContent = cart.length ? `Cobrar ${money(total)}` : 'Cobrar';
}
// Sonido corto de confirmación (agudo = agregado, grave = error): se puede cobrar sin mirar la pantalla.
let audioCtx = null;
function beep(ok = true) {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 1100 : 220; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* sin audio */ }
}
function addToCart(a) {
  const line = cart.find((l) => l.a.id === a.id);
  const qty = (line?.qty || 0) + 1;
  if (qty > avail(a)) { beep(false); const m = `Sin stock suficiente de ${articleLabel(a)} (hay ${Math.max(avail(a), 0)}${a.reserved ? `; ${a.reserved} apartado${a.reserved === 1 ? '' : 's'} con seña` : ''})`; $('#lastScan').innerHTML = `<span class="neg">${esc(m)}</span>`; return toast(m, true); }
  if (line) line.qty = qty; else cart.push({ a, qty: 1 });
  renderCart();
  beep(true);
  $('#lastScan').innerHTML = `✔ <b>${esc(articleLabel(a))}</b> · ${money(a.price)}${qty > 1 ? ` · ya van ${qty}` : ''}`;
  return true;
}
$('#cart').addEventListener('click', (e) => {
  const q = e.target.dataset.q, rm = e.target.dataset.rm;
  if (q) {
    const [i, d] = q.split(':').map(Number), l = cart[i];
    const n = l.qty + d;
    if (n < 1) cart.splice(i, 1); else if (n > avail(l.a)) return toast('Sin stock suficiente', true); else l.qty = n;
    renderCart();
  } else if (rm !== undefined) { cart.splice(Number(rm), 1); renderCart(); }
});
for (const [sel, key] of [['#discType', 'dType'], ['#sureType', 'sType']]) {
  $(sel).addEventListener('click', (e) => {
    if (!e.target.dataset.t) return;
    adj[key] = e.target.dataset.t;
    $$(sel + ' button').forEach((b) => b.classList.toggle('active', b === e.target));
    renderCart();
  });
}
$('#discVal').addEventListener('input', renderCart);
$('#sureVal').addEventListener('input', renderCart);
$('#payLines').addEventListener('input', (e) => {
  if (e.target.dataset.pa !== undefined) { payLines[e.target.dataset.pa].amount = e.target.value; updateChange(); }
});
$('#payLines').addEventListener('change', (e) => {
  if (e.target.dataset.pm !== undefined) { payLines[e.target.dataset.pm].method = e.target.value; updateChange(); }
});
$('#payLines').addEventListener('click', (e) => {
  if (e.target.dataset.prm !== undefined) { payLines.splice(Number(e.target.dataset.prm), 1); renderPayLines(); }
  if (e.target.dataset.prest !== undefined) { // este medio paga lo que no cubren los demás
    const i = Number(e.target.dataset.prest);
    const others = payLines.reduce((sum, l, k) => (k === i ? sum : sum + (Number(l.amount) || 0)), 0);
    payLines[i].amount = String(Math.max(0, r2(cartTotals().total - others)) || '');
    renderPayLines();
  }
});
$('#payAdd').addEventListener('click', () => {
  const used = new Set(payLines.map((l) => l.method));
  const next = ['efectivo', 'tarjeta', 'transferencia', ...(saleCustomer?.id ? ['cuenta'] : [])].find((m) => !used.has(m)) || 'efectivo';
  payLines.push({ method: next, amount: '' });
  renderPayLines();
  const first = $('#payLines input[data-pa]'); if (first && !first.value) first.focus(); // se escribe cuánto paga con cada medio (o «Resto»)
});
// Menú «＋» con las acciones menos usadas (señar, poner en espera, reimprimir, vaciar).
const closeMore = () => { $('#moreMenu').hidden = true; $('#moreBtn').setAttribute('aria-expanded', 'false'); };
$('#moreBtn').addEventListener('click', (e) => { e.stopPropagation(); const open = $('#moreMenu').hidden; $('#moreMenu').hidden = !open; $('#moreBtn').setAttribute('aria-expanded', String(open)); });
$('#moreMenu').addEventListener('click', closeMore);
document.addEventListener('click', (e) => { if (!e.target.closest('.moreWrap')) closeMore(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMore(); });
function useCredit() {
  const total = cartTotals().total, bal = saleCustomer?.balance || 0;
  if (!(bal > 0)) return;
  const use = Math.min(bal, total);
  // Si el saldo alcanza: pago completo con la cuenta. Si no, queda el otro medio en 0 y se ve cuánto falta.
  setPayLines(use >= total ? [{ method: 'cuenta', amount: '' }] : [{ method: 'cuenta', amount: String(use) }, { method: 'efectivo', amount: '' }]);
}

// Ventas en espera: se guardan en el servidor (sobreviven a cerrar la pantalla) y se retoman con los precios y el stock de ahora.
let heldId = null; // la venta en espera que se está cobrando (se borra sola al cobrarla)
const ago = (iso) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso.replace(' ', 'T')).getTime()) / 60000)); return m < 1 ? 'recién' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };
async function loadHeld() {
  const list = await api('GET', '/held');
  $('#heldBar').hidden = !list.length;
  $('#heldBar').innerHTML = list.map((h) => `<span class="heldChip${h.id === heldId ? ' on' : ''}">⏸ <b>${esc(h.label || h.customer_name || 'Venta ' + h.id)}</b>
    <span class="muted">${h.units} prenda${h.units === 1 ? '' : 's'} · ${money(h.total)} · ${ago(h.created_at)}</span>
    ${h.id === heldId ? '<span class="muted">(en pantalla)</span>' : `<button class="link" data-hresume="${h.id}">Retomar</button>`}<button class="link" data-hdrop="${h.id}" title="Descartar">✕</button></span>`).join('');
}
async function holdCart(label) {
  await api('POST', '/held', {
    label, replace_id: heldId || undefined, adjust: adjustBody(), customer_id: saleCustomer?.id, customer_name: saleCustomer?.id ? undefined : saleCustomer?.name,
    items: cart.map((l) => ({ article_id: l.a.id, qty: l.qty })),
  });
}
$('#holdSale').addEventListener('click', guard(async () => {
  if (!cart.length) throw new Error('No hay nada para poner en espera');
  const label = await uiPrompt('Nombre para reconocer esta venta (opcional)', saleCustomer?.name || '', { title: 'Poner en espera', ok: 'Poner en espera' });
  if (label === null) return;
  await holdCart(label.trim());
  resetSale(); toast('Venta puesta en espera: retomala desde arriba cuando quieras'); await loadHeld();
}));
$('#heldBar').addEventListener('click', guard(async (e) => {
  const drop = e.target.dataset.hdrop, resume = e.target.dataset.hresume;
  if (drop && await uiConfirm('Se pierde el carrito guardado.', { title: '¿Descartar esta venta en espera?', ok: 'Descartar', danger: true })) {
    await api('DELETE', '/held/' + drop);
    if (Number(drop) === heldId) heldId = null;
    return loadHeld();
  }
  if (!resume) return;
  if (cart.length) {
    if (!await uiConfirm('¿Ponerla en espera para retomar esta?', { title: 'Tenés una venta en curso', ok: 'Ponerla en espera' })) return;
    await holdCart(saleCustomer?.name || '');
  }
  const h = await api('GET', '/held/' + resume);
  resetSale();
  let capped = false;
  cart = h.items.map((i) => { const qty = Math.min(i.qty, avail(i.article)); if (qty < i.qty) capped = true; return { a: i.article, qty }; }).filter((l) => l.qty > 0);
  setAdjust(h.adjust || { discount_pct: h.discount_pct }); renderCart();
  saleCustomer = h.customer ? { id: h.customer.id, name: h.customer.name, doc: h.customer.doc, balance: h.customer.balance } : h.customer_name ? { name: h.customer_name } : null;
  heldId = h.id; renderCustomerChip(); renderCart();
  if (h.missing || capped) toast(`${h.missing ? 'Algunos artículos ya no existen. ' : ''}${capped ? 'Se ajustaron cantidades al stock disponible.' : ''}`, true);
  await loadHeld(); $('#scan').focus();
}));

// Cliente de la venta: con ficha (cuenta corriente, historial) o solo un nombre para el comprobante.
let saleCustomer = null; // { id, name, doc, balance } | { name } | null
const balanceHtml = (b) => (b > 0 ? `<span class="pos">${money(b)} a favor</span>` : b < 0 ? `<span class="neg">Debe ${money(-b)}</span>` : '<span class="muted">Sin saldo</span>');
function renderCustomerChip() {
  const c = saleCustomer, chip = $('#custChip');
  $('#custSearch').closest('label').hidden = !!c;
  chip.hidden = !c; $('#custResults').innerHTML = '';
  renderPayLines();
  if (c) chip.innerHTML = `<span>👤 <b>${esc(c.name)}</b>${c.doc ? ` · ${esc(c.doc)}` : ''}</span>${c.id ? balanceHtml(c.balance) : '<span class="muted">(sin ficha)</span>'}
    <span class="grow"></span>${c.id && c.balance > 0 ? '<button type="button" class="ghost" id="custUse">Usar saldo</button>' : ''}${c.id && can('clientes.cuenta') ? '<button type="button" class="ghost" id="custSena">Cargar seña</button>' : ''}<button type="button" class="link" id="custClear" title="Quitar cliente">✕</button>`;
  updateChange();
}
function setSaleCustomer(c) { saleCustomer = c; accountAsked = false; renderCustomerChip(); $('#scan').focus(); }
const custSearch = debounce(guard(async () => {
  const q = $('#custSearch').value.trim();
  if (!q) { $('#custResults').innerHTML = ''; return; }
  const list = await api('GET', '/customers?q=' + encodeURIComponent(q) + '&limit=6');
  window._custHits = list;
  $('#custResults').innerHTML = list.map((c) => `<div class="item" data-cid="${c.id}"><span>${esc(c.name)}${c.doc ? ` · ${esc(c.doc)}` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}</span><span>${balanceHtml(c.balance)}</span></div>`).join('')
    + (can('clientes.editar') ? `<div class="item" data-cnew="1"><span>＋ Crear cliente «${esc(q)}»</span></div>` : '')
    + `<div class="item" data-cfree="1"><span>Usar «${esc(q)}» solo en el comprobante (sin ficha)</span></div>`;
}));
$('#custSearch').addEventListener('input', custSearch);
$('#custSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); e.stopPropagation();
  const first = $('#custResults .item'); if (first) first.click();
});
$('#custBox').addEventListener('click', guard(async (e) => {
  const item = e.target.closest('.item');
  if (e.target.id === 'custClear') return setSaleCustomer(null);
  if (e.target.id === 'custUse') return useCredit();
  if (e.target.id === 'custSena') return openPayDialog({ mode: 'sena', customer: saleCustomer, done: refreshSaleCustomer });
  if (!item) return;
  const q = $('#custSearch').value.trim();
  if (item.dataset.cid) { const c = window._custHits.find((x) => x.id == item.dataset.cid); setSaleCustomer({ id: c.id, name: c.name, doc: c.doc, balance: c.balance }); }
  else if (item.dataset.cfree) setSaleCustomer({ name: q });
  else if (item.dataset.cnew) openCustomerDialog(null, { name: q }, (c) => setSaleCustomer({ id: c.id, name: c.name, doc: c.doc, balance: 0 }));
}));
async function refreshSaleCustomer() {
  if (!saleCustomer?.id) return;
  const list = await api('GET', '/customers?q=' + encodeURIComponent(saleCustomer.doc || saleCustomer.name) + '&limit=20');
  const c = list.find((x) => x.id === saleCustomer.id);
  if (c) { saleCustomer.balance = c.balance; renderCustomerChip(); }
}
function resetSale() {
  cart = []; heldId = null; accountAsked = false; setAdjust(); saleCustomer = null; payLines = [{ method: 'efectivo', amount: '' }]; renderCustomerChip();
  renderCart(); $('#results').innerHTML = ''; $('#scan').value = ''; $('#scan').focus();
}
$('#clearCart').addEventListener('click', resetSale);

async function searchInto(box, q, onPick) {
  const list = q ? await api('GET', '/articles?q=' + encodeURIComponent(q)) : [];
  box.innerHTML = list.map((a) => `<div class="item" data-id="${a.id}"><span>${esc(articleLabel(a))}</span><span>${money(a.price)} · stock ${a.stock}${a.reserved ? ` · ${a.reserved} apartado${a.reserved === 1 ? '' : 's'}` : ''}</span></div>`).join('');
  box.onclick = (e) => { const el = e.target.closest('.item'); if (el) onPick(list.find((a) => a.id == el.dataset.id)); };
  return list;
}
const liveSearch = debounce(guard(() => searchInto($('#results'), $('#scan').value.trim(), (a) => { addToCart(a); $('#results').innerHTML = ''; $('#scan').value = ''; $('#scan').focus(); })));
$('#scan').addEventListener('input', liveSearch);
// Un código leído (con el lector o escrito a mano): primero se busca el código exacto; si no está, se busca como texto.
async function scanCode(raw) {
  const code = raw.trim();
  if (!code) return;
  try {
    addToCart(await api('GET', '/articles/barcode/' + encodeURIComponent(code)));
    $('#scan').value = ''; $('#results').innerHTML = '';
  } catch {
    const list = await searchInto($('#results'), code, (a) => { addToCart(a); $('#results').innerHTML = ''; $('#scan').value = ''; $('#scan').focus(); });
    if (list.length === 1) { addToCart(list[0]); $('#scan').value = ''; $('#results').innerHTML = ''; }
    else if (list.length) toast('Elegí un artículo de la lista', false);
    else { beep(false); $('#lastScan').innerHTML = `<span class="neg">No existe ningún artículo con el código «${esc(code)}»</span>`; toast('Código o artículo no encontrado', true); $('#scan').select(); }
  }
  $('#scan').focus();
}
// El lector envía el código seguido de Enter (algunos, de Tab).
$('#scan').addEventListener('keydown', guard(async (e) => {
  if (e.key !== 'Enter' && !(e.key === 'Tab' && !e.shiftKey && e.target.value.trim())) return;
  e.preventDefault();
  await scanCode(e.target.value);
}));
// Si el lector escribe con el foco en otro campo (descuento, cliente, pagos…): una ráfaga rápida de teclas terminada en Enter
// es un código, no un dato para ese campo. Se deshace lo escrito y se carga como código.
let burst = null;
document.addEventListener('keydown', (e) => {
  const f = document.activeElement;
  if (currentTab !== 'venta' || !f || f.id === 'scan' || f.tagName !== 'INPUT' || $('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const now = performance.now();
  if (e.key.length === 1) {
    burst = burst && burst.field === f && now - burst.last < 50 ? { ...burst, text: burst.text + e.key, last: now } : { field: f, prev: f.value, text: e.key, last: now };
  } else if (e.key === 'Enter' && burst && burst.field === f && burst.text.length >= 6 && now - burst.last < 100) {
    e.preventDefault();
    f.value = burst.prev; f.dispatchEvent(new Event('input', { bubbles: true }));
    const code = burst.text; burst = null;
    guard(() => scanCode(code))();
  } else burst = null;
}, true);
// Tras tocar un botón de la venta, el foco vuelve al campo de escaneo (así el lector siempre escribe ahí).
$('#posBox').addEventListener('click', (e) => { if (e.target.closest('button') && !$('dialog[open]')) setTimeout(() => $('#scan').focus(), 0); });
$('#scan').addEventListener('input', () => ($('#lastScan').textContent = ''));

// Cliente con deuda o con saldo a favor: antes de cobrar se pregunta qué hacer (una vez por venta).
let accountAsked = false;
function payDebtNow(c, owed) {
  return new Promise((resolve) => {
    let paid = false;
    const opened = openPayDialog({ mode: 'deuda', customer: { ...c, balance: -owed }, done: async () => { paid = true; await refreshSaleCustomer(); resolve(true); } });
    if (!opened) return resolve(false);
    $('#payDialog').addEventListener('close', () => { if (!paid) resolve(false); }, { once: true });
  });
}
async function resolveCustomerAccount() {
  const c = saleCustomer;
  if (!c?.id || accountAsked) return true;
  await refreshSaleCustomer();
  const total = cartTotals().total;
  if (c.balance < 0) {
    const owed = -c.balance;
    const choice = await ask({
      title: `${c.name} tiene una deuda`, stack: true,
      text: `Debe ${money(owed)} y se lleva ${money(total)} ahora. ¿Qué querés hacer?`,
      buttons: [
        can('clientes.cuenta') ? { label: `Cobrar la deuda (${money(owed)}) y después esta compra`, value: 'pay', kind: 'primary' } : null,
        can('clientes.fiar') ? { label: `Sumar esta compra a la deuda (pasaría a deber ${money(owed + total)})`, value: 'add', kind: 'ghost' } : null,
        { label: 'Dejar una seña y apartar la mercadería', value: 'lay', kind: 'ghost' },
        { label: 'Cobrar solo esta compra (la deuda sigue)', value: 'only', kind: can('clientes.cuenta') ? 'ghost' : 'primary' },
        { label: 'Volver', value: null, kind: 'ghost', cancel: true },
      ].filter(Boolean),
    });
    if (!choice) return false;
    if (choice === 'lay') { openLayawayDialog(); return false; }
    if (choice === 'pay' && !(await payDebtNow(c, owed))) return false;
    if (choice === 'add') setPayLines([{ method: 'cuenta', amount: '' }]);
  } else if (c.balance > 0 && !accountEntered()) {
    if (await uiConfirm(`${c.name} tiene ${money(c.balance)} a favor. ¿Lo usás en esta compra?`, { title: 'Saldo a favor', ok: 'Usar el saldo', cancel: 'No usarlo' })) useCredit();
  }
  accountAsked = true;
  return true;
}
$('#charge').addEventListener('click', guard(async () => {
  if (!cart.length) throw new Error('La venta está vacía');
  if (!cash) throw new Error('Abrí la caja antes de vender');
  if (!(await resolveCustomerAccount())) return;
  const payments = paymentsEntered();
  const { total } = cartTotals();
  const sale = await api('POST', '/sales', { items: cart.map((l) => ({ article_id: l.a.id, qty: l.qty })), ...adjustBody(), payments, held_id: heldId || undefined, account_amount: accountEntered() || undefined, customer_id: saleCustomer?.id, customer_name: saleCustomer?.id ? undefined : saleCustomer?.name });
  toast(`Venta #${sale.id} registrada${sale.change ? ` · Vuelto ${money(sale.change)}` : ''}`);
  resetSale(); await loadCash();
  const full = (await api('GET', '/sales')).find((x) => x.id === sale.id);
  lastTicket = { ...full, change: sale.change };
  if ($('#autoTicket').checked && full) printTicket(lastTicket);
}));

// ---------- Clientes ----------
async function loadCustomers() {
  const q = encodeURIComponent($('#cliSearch').value.trim());
  let rows = await api('GET', `/customers?q=${q}&limit=500${$('#cliAll').checked ? '&all=1' : ''}`);
  if ($('#cliDebt').checked) rows = rows.filter((c) => c.balance !== 0);
  $('#cliTable tbody').innerHTML = rows.map((c) => `<tr data-cid="${c.id}" style="cursor:pointer${c.active ? '' : ';opacity:.5'}">
    <td><b>${esc(c.name)}</b>${c.active ? '' : ' <small>(de baja)</small>'}</td><td>${esc(c.doc || '—')}</td><td>${esc(c.phone || '—')}</td><td>${balanceHtml(c.balance)}</td>
    <td class="num">${c.sales_count}</td><td class="num">${money(c.sales_total)}</td><td>${esc((c.last_sale || '').slice(0, 10) || '—')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Todavía no hay clientes</td></tr>';
  const owed = rows.filter((c) => c.balance < 0).reduce((s, c) => s - c.balance, 0), credit = rows.filter((c) => c.balance > 0).reduce((s, c) => s + c.balance, 0);
  $('#cliNote').textContent = `${rows.length} cliente(s)${owed ? ` · Te deben ${money(owed)}` : ''}${credit ? ` · Saldo a favor de clientes ${money(credit)}` : ''}`;
}
$('#cliSearch').addEventListener('input', debounce(guard(loadCustomers)));
$('#cliAll').addEventListener('change', guard(loadCustomers));
$('#cliDebt').addEventListener('change', guard(loadCustomers));
$('#cliNew').addEventListener('click', () => openCustomerDialog());
$('#cliCancel').addEventListener('click', () => $('#cliDialog').close());
let editingCustomer = null, customerDone = null;
function openCustomerDialog(c, preset = {}, done = null) {
  editingCustomer = c?.id ?? null; customerDone = done;
  const f = $('#cliForm'); f.reset(); $('#cliError').textContent = '';
  $('#cliTitle').textContent = c ? 'Editar cliente' : 'Nuevo cliente';
  for (const k of ['name', 'doc', 'phone', 'email', 'note']) f.elements[k].value = c?.[k] ?? preset[k] ?? '';
  $('#cliDialog').showModal(); f.elements.name.focus();
}
$('#cliForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(e.target));
    const saved = editingCustomer ? await api('PUT', '/customers/' + editingCustomer, body) : await api('POST', '/customers', body);
    $('#cliDialog').close(); toast('Cliente guardado');
    if (customerDone) customerDone(saved);
    if (currentTab === 'clientes') { await loadCustomers(); if ($('#cliDetail').open) await openCustomerDetail(saved.id); }
  } catch (err) { $('#cliError').textContent = err.message; }
});
$('#cliTable').addEventListener('click', guard((e) => { const tr = e.target.closest('tr[data-cid]'); if (tr) return openCustomerDetail(tr.dataset.cid); }));
$('#cdClose').addEventListener('click', () => $('#cliDetail').close());
async function openCustomerDetail(id) {
  const c = await api('GET', '/customers/' + id);
  $('#cdName').textContent = c.name;
  $('#cdInfo').textContent = [c.doc && `DNI/CUIT ${c.doc}`, c.phone && `Tel. ${c.phone}`, c.email, c.note].filter(Boolean).join(' · ') || 'Sin más datos';
  $('#cdKpis').innerHTML = [['Cuenta', c.balance > 0 ? `${money(c.balance)} a favor` : c.balance < 0 ? `Debe ${money(-c.balance)}` : 'Sin saldo'], ['Compras', c.sales_count], ['Total comprado', money(c.sales_total)], ['Última compra', (c.last_sale || '—').slice(0, 10)]]
    .map(([k, v]) => `<div class="kpi"><span>${k}</span><b style="font-size:18px">${v}</b></div>`).join('');
  const act = [];
  if (can('clientes.cuenta') && c.active) {
    act.push(`<button class="primary" data-act="sena">Cargar seña / saldo</button>`);
    if (c.balance < 0) act.push(`<button class="primary" data-act="deuda">Cobrar deuda</button>`);
    if (c.balance > 0) act.push(`<button class="ghost" data-act="payout">Devolver saldo</button>`);
  }
  if (can('clientes.editar')) act.push(`<button class="ghost" data-act="edit">Editar</button><button class="ghost" data-act="toggle">${c.active ? 'Dar de baja' : 'Reactivar'}</button>`);
  $('#cdActions').innerHTML = act.join('');
  $('#cdActions').onclick = guard(async (e) => {
    const a = e.target.dataset.act; if (!a) return;
    const done = async () => { await openCustomerDetail(c.id); await loadCustomers(); };
    if (a === 'edit') return openCustomerDialog(c);
    if (a === 'toggle') { await api('PUT', '/customers/' + c.id, { active: !c.active }); toast(c.active ? 'Cliente dado de baja' : 'Cliente reactivado'); return done(); }
    openPayDialog({ mode: a, customer: c, done });
  });
  const lays = can('ventas.cobrar') || can('clientes.ver') ? await api('GET', '/layaways?customer_id=' + c.id) : [];
  $('#cdLay').hidden = !lays.length;
  $('#cdLayTable tbody').innerHTML = lays.map((l) => layRow(l, {})).join('');
  $('#cdMovs tbody').innerHTML = c.movements.map((m) => `<tr><td>${esc(m.created_at.slice(0, 16))}</td><td>${esc(m.concept)}${m.method ? ` <small class="muted">(${esc(m.method)})</small>` : ''}</td>
    <td class="num ${m.amount > 0 ? 'pos' : 'neg'}">${m.amount > 0 ? '+' : ''}${money(m.amount)}</td><td>${esc(m.user_name || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin movimientos</td></tr>';
  $('#cdSales tbody').innerHTML = c.sales.map((v) => `<tr style="${v.voided ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${v.id}</td><td>${esc(v.created_at.slice(0, 16))}</td>
    <td>${v.items.map((i) => `${i.qty}× ${esc(i.name)}`).join('<br>')}</td><td class="num">${money(v.total)}</td><td>${v.voided ? 'Anulada' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Todavía no compró</td></tr>';
  if (!$('#cliDetail').open) $('#cliDetail').showModal();
}
// Seña / cobro de deuda / devolución de saldo (mueven la caja y la cuenta del cliente).
let payCtx = null;
function openPayDialog({ mode, customer, done }) {
  if (!cash) { toast('Abrí la caja para registrar el movimiento', true); return false; }
  payCtx = { mode, customer, done };
  const f = $('#payForm'); f.reset(); $('#payError').textContent = '';
  const T = {
    sena: ['Cargar seña o saldo', `Entra a la caja y queda a favor de ${customer.name}: después se descuenta de su compra.`],
    deuda: ['Cobrar deuda', `${customer.name} debe ${money(-(customer.balance || 0))}.`],
    payout: ['Devolver saldo a favor', `Sale de la caja. ${customer.name} tiene ${money(customer.balance || 0)} a favor.`],
  }[mode];
  $('#payTitle').textContent = T[0]; $('#payHelp').textContent = T[1];
  if (mode === 'deuda') f.elements.amount.value = -customer.balance;
  if (mode === 'payout') f.elements.amount.value = customer.balance;
  $('#payDialog').showModal(); f.elements.amount.focus();
  return true;
}
$('#payCancel').addEventListener('click', () => $('#payDialog').close());
$('#payForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { mode, customer, done } = payCtx, f = e.target.elements;
  try {
    const path = `/customers/${customer.id}/${mode === 'payout' ? 'payout' : 'payment'}`;
    await api('POST', path, { amount: Number(f.amount.value), method: f.method.value, concept: { sena: 'Seña / adelanto', deuda: 'Pago de deuda' }[mode] });
    toast('Movimiento registrado'); await refreshCash(); if (done) await done(); $('#payDialog').close();
  } catch (err) { $('#payError').textContent = err.message; }
});

// ---------- Artículos ----------
async function loadArticles() {
  const q = encodeURIComponent($('#artSearch').value.trim());
  const brandSel = $('#artBrand').value;
  const rows = await api('GET', `/articles?q=${q}&low=${$('#artLow').checked ? 1 : 0}${brandSel ? `&brand_id=${brandSel}` : ''}`);
  $('#artTable tbody').innerHTML = rows.map((a) => `
    <tr><td>${esc(a.barcode || '—')}</td><td>${esc(a.brand || '—')}</td><td>${esc(a.name)}</td><td>${esc(a.category)}</td><td>${esc(a.size)}</td><td>${esc(a.color)}</td>
    <td class="num">${money(a.price)}</td><td class="num col-cost">${money(a.cost)}</td>
    <td class="num ${a.stock <= a.min_stock ? 'low' : ''}">${a.stock}${a.reserved ? `<br><small class="muted">${a.reserved} apartado${a.reserved === 1 ? '' : 's'}</small>` : ''}</td>
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
    const name = await uiPrompt('Nuevo nombre de la marca:', d.name, { title: 'Renombrar marca', ok: 'Guardar' });
    if (name === null) return;
    await api('PUT', '/brands/' + d.brename, { name }); toast('Marca renombrada'); await loadArticles();
  }
  if (d.bdel && await uiConfirm('Solo se puede si no tiene artículos.', { title: '¿Borrar esta marca?', ok: 'Borrar', danger: true })) { await api('DELETE', '/brands/' + d.bdel); toast('Marca borrada'); await loadBrands(); }
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
  if (e.target.dataset.del && await uiConfirm('Se conserva el historial de ventas.', { title: '¿Dar de baja este artículo?', ok: 'Dar de baja', danger: true })) {
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
// Cambio masivo de precios
let prWho = 'group', prPicked = new Map(), prFound = [];
const prBody = () => ({
  ...(prWho === 'items' ? { article_ids: [...prPicked.keys()] } : { brand_id: $('#prBrand').value || null, category: $('#prCategory').value, query: $('#prQuery').value, only_stock: $('#prStock').checked }),
  target: $('#prTarget').value, mode: $('#prMode').value, value: $('#prValue').value === '' ? 0 : Number($('#prValue').value), round: Number($('#prRound').value) });
function renderPricePicked() {
  $('#prPickedCount').textContent = `(${prPicked.size})`;
  $('#prPicked tbody').innerHTML = [...prPicked].map(([id, label]) => `<tr><td>${esc(label)}</td><td><button type="button" class="link" data-prm2="${id}">Quitar</button></td></tr>`).join('') || '<tr><td colspan="2" class="muted">Todavía no elegiste artículos</td></tr>';
}
async function searchPriceArticles() {
  const q = $('#prSearch').value.trim();
  prFound = q ? await api('GET', `/articles?limit=40&q=${encodeURIComponent(q)}`) : [];
  $('#prResults tbody').innerHTML = prFound.map((a, i) => `<tr data-ppick="${i}" style="cursor:pointer${prPicked.has(a.id) ? ';opacity:.45' : ''}"><td>${esc(articleLabel(a))}</td><td class="num">${money(a.price)}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">${q ? 'No se encontró ningún artículo' : 'Escribí para buscar'}</td></tr>`;
}
function setPriceWho(w) {
  prWho = w;
  $$('#prWho button').forEach((b) => b.classList.toggle('active', b.dataset.w === w));
  $('#prGroup').hidden = w !== 'group'; $('#prItems').hidden = w !== 'items';
  prReset();
}
$('#prWho').addEventListener('click', (e) => { if (e.target.dataset.w) { setPriceWho(e.target.dataset.w); if (e.target.dataset.w === 'items') $('#prSearch').focus(); } });
$('#prSearch').addEventListener('input', debounce(guard(searchPriceArticles)));
$('#prResults').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-ppick]'); if (!tr) return; const a = prFound[Number(tr.dataset.ppick)]; prPicked.set(a.id, articleLabel(a)); renderPricePicked(); searchPriceArticles(); prReset(); });
$('#prPicked').addEventListener('click', (e) => { if (e.target.dataset.prm2) { prPicked.delete(Number(e.target.dataset.prm2)); renderPricePicked(); searchPriceArticles(); prReset(); } });
async function loadPriceHistory() {
  const h = await api('GET', '/prices/history');
  $('#prHistory tbody').innerHTML = h.map((b) => `<tr><td>${esc(b.created_at.slice(0, 16))}</td><td>${esc(b.description)}</td><td class="num">${b.count} art.</td><td>${b.undone ? '<span class="muted">deshecho</span>' : ''}</td></tr>`).join('') || '<tr><td class="muted">Todavía no hubo cambios</td></tr>';
  $('#prUndo').disabled = !h.some((b) => !b.undone);
}
function prReset() { $('#prPreviewBox').hidden = true; $('#prApply').disabled = true; $('#prSummary').textContent = ''; setMsg('prError', ''); }
$('#artPrices').addEventListener('click', guard(async () => {
  const brands = await api('GET', '/brands');
  $('#prBrand').innerHTML = '<option value="">Todas las marcas</option>' + brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $$('#prTarget option.col-cost').forEach((o) => { o.hidden = o.disabled = !can('costos.ver'); });
  $('#prTarget').value = 'price'; $('#prValue').value = ''; prPicked = new Map(); $('#prSearch').value = ''; renderPricePicked(); searchPriceArticles(); setPriceWho('group');
  await loadPriceHistory();
  $('#priceDialog').showModal();
}));
['prBrand', 'prCategory', 'prQuery', 'prStock', 'prTarget', 'prMode', 'prValue', 'prRound'].forEach((id) => $('#' + id).addEventListener('input', prReset));
$('#prClose').addEventListener('click', () => $('#priceDialog').close());
$('#prPreview').addEventListener('click', guard(async () => {
  prReset();
  try {
    const r = await api('POST', '/prices/preview', prBody());
    $('#prSummary').textContent = `${r.changed} de ${r.total} artículos cambian${r.changed > r.items.length ? ` (se muestran los primeros ${r.items.length})` : ''}.`;
    $('#prTable tbody').innerHTML = r.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${money(i.old_price)}</td><td class="num"><b>${money(i.new_price)}</b></td><td class="num col-cost">${i.old_cost === undefined ? '' : money(i.old_cost)}</td><td class="num col-cost">${i.new_cost === undefined ? '' : money(i.new_cost)}</td></tr>`).join('') || '<tr><td class="muted" colspan="5">Ningún artículo cambia con estos valores</td></tr>';
    $('#prPreviewBox').hidden = false; $('#prApply').disabled = !r.changed;
    $('#prApply').dataset.changed = r.changed; $('#prApply').dataset.desc = r.description;
  } catch (e) { setMsg('prError', e.message); }
}));
$('#prApply').addEventListener('click', guard(async () => {
  const n = $('#prApply').dataset.changed;
  if (!(await uiConfirm(`Se van a cambiar ${n} artículos: ${$('#prApply').dataset.desc}.\n\nDespués podés deshacerlo desde el historial.`, { title: 'Cambiar precios', ok: 'Aplicar' }))) return;
  try {
    const r = await api('POST', '/prices/apply', prBody());
    toast(`Listo: se actualizaron ${r.changed} artículos`);
    prReset(); await loadPriceHistory(); await loadArticles();
  } catch (e) { setMsg('prError', e.message); }
}));
$('#prUndo').addEventListener('click', guard(async () => {
  if (!(await uiConfirm('Se vuelven a poner los precios (y costos) anteriores del último cambio. Si después editaste a mano alguno de esos artículos, también vuelve al valor de antes.', { title: 'Deshacer el último cambio', ok: 'Deshacer', danger: true }))) return;
  try {
    const r = await api('POST', '/prices/undo', {});
    toast(`Se deshizo el cambio (${r.restored} artículos)`);
    prReset(); await loadPriceHistory(); await loadArticles();
  } catch (e) { setMsg('prError', e.message); }
}));

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
const REASON = { inicial: 'Carga inicial', compra: 'Compra', venta: 'Venta', anulacion: 'Anulación de venta', anulacion_compra: 'Anulación de compra', correccion_compra: 'Corrección de compra', ajuste: 'Ajuste', devolucion: 'Devolución', limpieza: 'Limpieza de stock' };
async function loadStock() {
  $('#offManage').hidden = !can('stock.ver');
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
  const q = $('#adjScan').value.trim(), brand = $('#sbBrand').value, low = $('#sbLow').checked, offersOnly = $('#sbOffers').checked, my = ++sbSeq;
  if (!q && !brand && !low && !offersOnly) {
    $('#sbTable tbody').innerHTML = '<tr><td colspan="6" class="muted">Escribí o escaneá a la izquierda, o elegí una marca o un filtro arriba, para ver los artículos.</td></tr>';
    $('#sbNote').textContent = ''; return;
  }
  const rows = await api('GET', `/articles?q=${encodeURIComponent(q)}${brand ? `&brand_id=${brand}` : ''}${low ? '&low=1' : ''}${offersOnly ? '&offers=1' : ''}&limit=300`);
  const total = api.total;
  if (my !== sbSeq) return; // llegó una respuesta de una búsqueda anterior
  window._sb = rows;
  $('#sbTable tbody').innerHTML = rows.map((a) => `<tr data-id="${a.id}" class="${adjArticle?.id === a.id ? 'sel' : ''}"><td>${esc(a.brand || '—')}</td><td>${esc(a.name)}</td><td>${esc(a.size)}</td><td>${esc(a.color)}</td><td class="num ${a.stock <= a.min_stock ? 'low' : ''}">${a.stock}</td><td>${a.offer_name ? `<span class="tag" title="${esc(a.offer_name)}">OFERTA · ${esc(a.offer_name.length > 22 ? a.offer_name.slice(0, 21) + '…' : a.offer_name)}</span>` : ''}</td></tr>`).join('')
    || `<tr><td colspan="6" class="muted">${offersOnly ? 'No hay artículos en ofertas vigentes' : 'No se encontró ningún artículo'}</td></tr>`;
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
    $('#dockMov').hidden = !operar; $('#dockClose').hidden = !operar; $('#dockList').hidden = !ver;
  }
  if (can('ventas.cobrar')) {
    await loadHeld();
    const lays = await api('GET', '/layaways');
    $('#layBox').hidden = !lays.length;
    $('#layTable tbody').innerHTML = lays.map((l) => layRow(l, { cust: true, date: true })).join('');
  }
  const day = $('#salesDate').value || today();
  const sales = await api('GET', '/sales?date=' + day);
  $('#salesTable tbody').innerHTML = sales.map((s) => `<tr style="${s.voided ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${compNumber(s)}</td><td>${time(s.created_at)}</td><td>${esc(s.seller || '')}${s.customer_name ? `<br><small class="muted">Cliente: ${esc(s.customer_name)}</small>` : ''}</td>
    <td>${s.items.map((i) => `${i.qty}× ${esc(i.name)}`).join('<br>')}</td><td>${s.payments.map((p) => `${p.method} ${money(p.amount)}`).join('<br>')}</td>
    <td class="num">${money(s.total)}${s.returned_value ? `<br><small class="muted">devuelto ${money(s.returned_value)}</small>` : ''}</td><td><button class="link" data-reprint="${s.id}">Imprimir</button>${s.voided ? 'Anulada' : [
      cash && can('ventas.devolver') && s.items.some((i) => i.qty > i.returned) ? `<button class="link" data-ret="${s.id}">Cambio / devolución</button>` : '',
      cash && day === today() && can('ventas.anular') && !s.returned_value && !s.exchange_amount ? `<button class="link" data-void="${s.id}">Anular</button>` : ''].join('')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin ventas en esta fecha</td></tr>';
  const rets = await api('GET', '/returns?date=' + day);
  $('#returnsBox').hidden = !rets.length;
  window._rets = rets;
  $('#retTable tbody').innerHTML = rets.map((r) => `<tr><td>${String(r.id).padStart(5, '0')}</td><td>${time(r.created_at)}</td><td><b>${r.kind === 'cambio' ? 'Cambio' : 'Devolución'}</b><br><small class="muted">venta ${compNumber({ id: r.sale_id })}</small></td>
    <td>${r.items.map((i) => `↩ ${i.qty}× ${esc(i.name)}`).join('<br>')}${r.new_items.length ? '<br>' + r.new_items.map((i) => `➜ ${i.qty}× ${esc(i.name)}`).join('<br>') : ''}</td>
    <td class="num">${money(r.value)}</td><td>${returnResolution(r)}</td><td><button class="link" data-rprint="${r.id}">Imprimir</button></td></tr>`).join('');
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
// Ingreso / egreso, movimientos y cierre de caja: ventanitas que se abren desde los botones de la pantalla de ventas.
$('#dockMov').addEventListener('click', () => { $('#movForm').reset(); $('#movError').textContent = ''; $('#movDialog').showModal(); $('#movAmount').focus(); });
$('#movCancel').addEventListener('click', () => $('#movDialog').close());
$('#movForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/cash/movement', { type: $('#movType').value, method: $('#movMethod').value, amount: Number($('#movAmount').value), concept: $('#movConcept').value });
    $('#movDialog').close(); toast('Movimiento registrado'); await loadCash();
  } catch (err) { $('#movError').textContent = err.message; }
});
$('#dockList').addEventListener('click', guard(async () => {
  const movs = await api('GET', '/cash/movements');
  $('#cashMovTable tbody').innerHTML = movs.map((x) => `<tr><td>${time(x.created_at)}</td><td class="${x.type === 'ingreso' ? 'pos' : 'neg'}">${x.type}</td><td>${x.method}</td><td class="num">${money(x.amount)}</td><td>${esc(x.concept)}</td><td>${esc(x.user_name || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin movimientos</td></tr>';
  $('#movListDialog').showModal();
}));
$('#movListClose').addEventListener('click', () => $('#movListDialog').close());
$('#dockClose').addEventListener('click', () => { $('#closeForm').reset(); $('#expected').textContent = cash ? `Efectivo esperado: ${money(cash.expected_cash_now)}` : ''; $('#closeDialog').showModal(); $('#closeCounted').focus(); });
$('#closeCancel').addEventListener('click', () => $('#closeDialog').close());
$('#closeForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  if (!await uiConfirm('No se podrán registrar ventas hasta abrir una nueva.', { title: '¿Cerrar la caja?', ok: 'Cerrar caja', danger: true })) return;
  const r = await api('POST', '/cash/close', { counted: Number($('#closeCounted').value), note: $('#closeNote').value });
  e.target.reset(); $('#closeDialog').close();
  await uiAlert(`Esperado: ${money(r.expected_cash)}\nContado: ${money(r.counted_cash)}\nDiferencia: ${money(r.difference)}`, 'Caja cerrada');
  await loadCash();
}));
$('#retTable').addEventListener('click', (e) => { const r = window._rets.find((x) => x.id == e.target.dataset.rprint); if (r) printReturn(r); });
$('#salesTable').addEventListener('click', guard(async (e) => {
  if (e.target.dataset.reprint) {
    const s = (await api('GET', '/sales?date=' + ($('#salesDate').value || today()))).find((x) => x.id == e.target.dataset.reprint);
    if (s) printTicket(s);
    return;
  }
  if (e.target.dataset.ret) {
    const s = (await api('GET', '/sales?date=' + ($('#salesDate').value || today()))).find((x) => x.id == e.target.dataset.ret);
    if (s) openReturnDialog(s);
    return;
  }
  if (e.target.dataset.void && await uiConfirm('Se devuelve el stock y se registra el egreso en caja.', { title: '¿Anular la venta?', ok: 'Anular venta', danger: true })) {
    await api('POST', `/sales/${e.target.dataset.void}/void`); toast('Venta anulada'); await loadCash();
  }
}));

// ---------- Apartados (señas) ----------
let layCtx = null; // { customer, lines }
const layTotal = () => Math.round(cart.reduce((sum, l) => sum + l.a.price * l.qty, 0) * 100) / 100;
function openLayawayDialog() {
  if (!cart.length) return toast('Cargá primero la mercadería que se aparta', true);
  if (!saleCustomer?.id) { toast('Elegí o creá el cliente que deja la seña', true); return $('#custSearch').focus(); }
  if (!cash) return toast('Abrí la caja para cobrar la seña', true);
  if (hasAdjust()) toast('Los descuentos y recargos no se aplican a las señas: el apartado se arma a precio de lista.', true);
  const total = layTotal();
  layCtx = { customer: saleCustomer };
  $('#layInfo').textContent = `Cliente: ${saleCustomer.name}${saleCustomer.doc ? ` · ${saleCustomer.doc}` : ''}`;
  $('#layItems tbody').innerHTML = cart.map((l) => `<tr><td>${esc(articleLabel(l.a))}</td><td class="num">${l.qty}</td><td class="num">${money(l.a.price * l.qty)}</td></tr>`).join('');
  const opt = $('#layMethod option[value="cuenta"]'); opt.hidden = !(saleCustomer.balance > 0);
  $('#layMethod').value = 'efectivo'; $('#layNote').value = ''; $('#layError').textContent = '';
  $('#layAmount').value = ''; $('#layAmount').max = total;
  layRefresh();
  $('#layDialog').showModal(); $('#layAmount').focus();
}
function layRefresh() {
  const total = layTotal(), dep = Number($('#layAmount').value) || 0, rest = Math.round((total - dep) * 100) / 100;
  $('#laySummary').innerHTML = `Total <b>${money(total)}</b> · ${dep > 0 ? (rest <= 0 ? '<b class="pos">Paga todo: se entrega ahora</b>' : `Deja <b>${money(dep)}</b> · Faltan <b class="neg">${money(rest)}</b>`) : 'Indicá cuánto deja de seña'}
    <br><small class="muted">La mercadería queda apartada (nadie más puede venderla). Al completar el pago se entrega, sale del stock y se cierra el apartado. El precio queda fijo hoy.</small>`;
}
$('#layAmount').addEventListener('input', layRefresh);
$('#layaway').addEventListener('click', openLayawayDialog);
$('#layCancelBtn').addEventListener('click', () => $('#layDialog').close());
$('#layForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/layaways', {
      customer_id: layCtx.customer.id, items: cart.map((l) => ({ article_id: l.a.id, qty: l.qty })),
      deposit: { amount: Number($('#layAmount').value), method: $('#layMethod').value }, note: $('#layNote').value,
    });
    $('#layDialog').close();
    if (heldId) await api('DELETE', '/held/' + heldId).catch(() => {});
    resetSale(); await refreshCash(); await loadCash();
    if (r.sale) { toast('Pagó todo: venta registrada'); const full = (await api('GET', '/sales')).find((x) => x.id === r.sale.id); if (full) printTicket({ ...full, change: 0 }); }
    else { toast(`Apartado #${r.id}: dejó ${money(r.paid)}, faltan ${money(r.remaining)}`); printLayaway(r); }
  } catch (err) { $('#layError').textContent = err.message; }
});

let layPaying = null;
async function openLayPay(id) {
  const l = await api('GET', '/layaways/' + id);
  layPaying = l;
  $('#layPayTitle').textContent = `Cobrar apartado #${l.id}`;
  $('#layPayInfo').textContent = `${l.customer_name} · Total ${money(l.total)} · Ya pagó ${money(l.paid)} · Falta ${money(l.remaining)}`;
  $('#layPayAmount').value = l.remaining; $('#layPayAmount').max = l.remaining;
  $('#layPayMethod option[value="cuenta"]').hidden = !(l.customer_balance > 0); $('#layPayMethod').value = 'efectivo';
  $('#layPayHint').textContent = 'Si paga todo lo que falta, el apartado se completa: se entrega, sale del stock y queda cerrado.';
  $('#layPayError').textContent = '';
  $('#layPayDialog').showModal(); $('#layPayAmount').select();
}
$('#layPayCancel').addEventListener('click', () => $('#layPayDialog').close());
$('#layPayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', `/layaways/${layPaying.id}/payment`, { amount: Number($('#layPayAmount').value), method: $('#layPayMethod').value });
    $('#layPayDialog').close(); await refreshCash();
    if (r.sale) {
      toast('Apartado completado: se entregó y se descontó del stock');
      const full = (await api('GET', '/sales')).find((x) => x.id === r.sale.id); if (full) printTicket({ ...full, change: 0 });
    } else { toast(`Pago registrado. Faltan ${money(r.remaining)}`); printLayaway(r); }
    await loadCash(); if ($('#cliDetail').open) await openCustomerDetail(r.customer_id);
  } catch (err) { $('#layPayError').textContent = err.message; }
});
async function cancelLayaway(id) {
  const l = await api('GET', '/layaways/' + id);
  const choice = await ask({
    title: `Cancelar el apartado #${l.id}`, stack: true,
    text: `${l.customer_name} había dejado ${money(l.paid)}. La mercadería vuelve a estar disponible. ¿Qué se hace con la seña?`,
    buttons: [{ label: 'Devolverla en efectivo', value: 'efectivo', kind: 'primary' }, { label: 'Devolverla por transferencia', value: 'transferencia', kind: 'ghost' },
      { label: 'Dejarla como saldo a favor del cliente', value: 'credit', kind: 'ghost' }, { label: 'No cancelar', value: null, kind: 'ghost', cancel: true }],
  });
  if (!choice) return;
  await api('POST', `/layaways/${id}/cancel`, { refund: choice });
  toast('Apartado cancelado'); await refreshCash(); await loadCash(); if ($('#cliDetail').open) await openCustomerDetail(l.customer_id);
}
const layRow = (l, cols) => `<tr><td>${String(l.id).padStart(5, '0')}</td>${cols.cust ? `<td><b>${esc(l.customer_name)}</b><br><small class="muted">${esc(l.customer_phone || '')}</small></td>` : ''}
  <td>${l.items.map((i) => `${i.qty}× ${esc(i.name)}`).join('<br>')}</td><td class="num">${money(l.total)}</td><td class="num">${money(l.paid)}</td><td class="num neg">${money(l.remaining)}</td>
  ${cols.date ? `<td>${esc(l.created_at.slice(0, 10))}</td>` : ''}<td><button class="link" data-laypay="${l.id}">Cobrar</button><button class="link" data-layprint="${l.id}">Imprimir</button>${can('ventas.devolver') ? `<button class="link" data-laycancel="${l.id}">Cancelar</button>` : ''}</td></tr>`;
document.addEventListener('click', guard(async (e) => {
  const d = e.target.dataset;
  if (d.laypay) return openLayPay(d.laypay);
  if (d.laycancel) return cancelLayaway(d.laycancel);
  if (d.layprint) return printLayaway(await api('GET', '/layaways/' + d.layprint));
}));

// ---------- Cambios y devoluciones ----------
const returnResolution = (r) => [
  r.exchange_amount ? `Cubre ${money(r.exchange_amount)} de la prenda nueva` : '',
  r.new_sale && r.new_sale.total - r.exchange_amount > 0 ? `Pagó ${money(r.new_sale.total - r.exchange_amount)} de diferencia` : '',
  r.refund_cash ? `Se devolvieron ${money(r.refund_cash)} (${r.refund_method})` : '',
  r.credit_amount ? `${money(r.credit_amount)} a saldo a favor` : '',
].filter(Boolean).join('<br>') || '—';
let ret = null; // { sale, back: {saleItemId: qty}, fresh: [{a, qty}], customer }
function retTotals() {
  const { sale } = ret;
  const ratio = sale.subtotal ? (sale.total - (sale.exchange_amount || 0)) / sale.subtotal : 1;
  let R = 0;
  for (const i of sale.items) R += r2((ret.back[i.id] || 0) * i.price * ratio);
  R = Math.min(r2(R), r2(sale.total - (sale.exchange_amount || 0) - (sale.returned_value || 0)));
  const N = r2(ret.fresh.reduce((s, l) => s + l.a.price * l.qty, 0));
  const exchange = Math.min(R, N);
  return { R, N, exchange, due: r2(N - exchange), left: r2(R - exchange), ratio };
}
function openReturnDialog(sale) {
  ret = { sale, back: {}, fresh: [], customer: sale.customer_id ? { id: sale.customer_id, name: sale.customer_name } : null };
  $('#retTitle').textContent = `Cambio o devolución · venta ${compNumber(sale)}`;
  $('#retInfo').textContent = `${when(sale)}${sale.customer_name ? ` · Cliente: ${sale.customer_name}` : ''} · Total ${money(sale.total)}`;
  $('#retScan').value = ''; $('#retResults').innerHTML = ''; $('#retNote').value = ''; $('#retError').textContent = ''; $('#retLeft').value = 'efectivo';
  $('#retCust').value = ''; $('#retCustResults').innerHTML = '';
  $$('#retPayBox [data-rp]').forEach((i) => (i.value = '')); $('#retAcc').value = '';
  $('#retAccWrap').hidden = !ret.customer;
  renderReturn();
  $('#retDialog').showModal();
}
function renderReturn() {
  const { sale } = ret, t = retTotals();
  $('#retItems tbody').innerHTML = sale.items.map((i) => {
    const max = i.qty - i.returned;
    return `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${i.returned || '—'}</td>
      <td>${max ? `<input type="number" min="0" max="${max}" value="${ret.back[i.id] || 0}" data-rb="${i.id}" data-max="${max}" style="width:70px">` : '<span class="muted">—</span>'}</td>
      <td class="num">${money(r2((ret.back[i.id] || 0) * i.price * t.ratio))}</td></tr>`;
  }).join('');
  $('#retNew tbody').innerHTML = ret.fresh.map((l, k) => `<tr><td>${esc(articleLabel(l.a))}</td>
    <td><button type="button" class="link" data-rq="${k}:-1">−</button> ${l.qty} <button type="button" class="link" data-rq="${k}:1">+</button></td>
    <td class="num">${money(l.a.price * l.qty)}</td><td><button type="button" class="link" data-rrm="${k}">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin prendas nuevas: es una devolución</td></tr>';
  const parts = [`Devuelve <b>${money(t.R)}</b>`];
  if (ret.fresh.length) parts.push(`Se lleva <b>${money(t.N)}</b>`);
  parts.push(t.due > 0 ? `<b class="neg">El cliente paga ${money(t.due)}</b>` : t.left > 0 ? `<b class="pos">Se le devuelven ${money(t.left)}</b>` : t.R > 0 ? '<b>Cambio parejo: no hay diferencia</b>' : '');
  $('#retSummary').innerHTML = parts.filter(Boolean).join(' · ');
  $('#retPayBox').hidden = !(t.due > 0);
  $('#retLeftBox').hidden = !(t.left > 0);
  $('#retCustBox').hidden = !(t.left > 0 && $('#retLeft').value === 'credit' && !ret.sale.customer_id);
  $('#retOk').disabled = !(t.R > 0);
}
$('#retItems').addEventListener('input', (e) => {
  const id = e.target.dataset.rb; if (!id) return;
  ret.back[id] = Math.max(0, Math.min(Number(e.target.dataset.max), Math.floor(Number(e.target.value) || 0)));
  renderReturn(); $(`#retItems [data-rb="${id}"]`).focus();
});
$('#retNew').addEventListener('click', (e) => {
  if (e.target.dataset.rq) { const [k, d] = e.target.dataset.rq.split(':').map(Number), l = ret.fresh[k]; l.qty += d; if (l.qty < 1) ret.fresh.splice(k, 1); else if (l.qty > avail(l.a)) { l.qty = avail(l.a); toast('Sin stock suficiente', true); } }
  if (e.target.dataset.rrm) ret.fresh.splice(Number(e.target.dataset.rrm), 1);
  renderReturn();
});
function addFresh(a) {
  const l = ret.fresh.find((x) => x.a.id === a.id);
  if ((l?.qty || 0) + 1 > avail(a)) return toast(`Sin stock suficiente de ${articleLabel(a)} (hay ${Math.max(avail(a), 0)})`, true);
  if (l) l.qty++; else ret.fresh.push({ a, qty: 1 });
  beep(true); renderReturn();
}
$('#retScan').addEventListener('input', debounce(guard(() => searchInto($('#retResults'), $('#retScan').value.trim(), (a) => { addFresh(a); $('#retResults').innerHTML = ''; $('#retScan').value = ''; $('#retScan').focus(); }))));
$('#retScan').addEventListener('keydown', guard(async (e) => {
  if (e.key !== 'Enter' && e.key !== 'Tab') return;
  const code = e.target.value.trim(); if (!code) return;
  e.preventDefault();
  try { addFresh(await api('GET', '/articles/barcode/' + encodeURIComponent(code))); e.target.value = ''; $('#retResults').innerHTML = ''; }
  catch {
    const list = await searchInto($('#retResults'), code, (a) => { addFresh(a); $('#retResults').innerHTML = ''; e.target.value = ''; });
    if (list.length === 1) { addFresh(list[0]); e.target.value = ''; $('#retResults').innerHTML = ''; } else if (!list.length) { beep(false); toast('Código o artículo no encontrado', true); }
  }
}));
$('#retLeft').addEventListener('change', renderReturn);
$('#retCust').addEventListener('input', debounce(guard(async () => {
  const q = $('#retCust').value.trim();
  const list = q ? await api('GET', '/customers?q=' + encodeURIComponent(q) + '&limit=6') : [];
  $('#retCustResults').innerHTML = list.map((c) => `<div class="item" data-rc="${c.id}" data-n="${esc(c.name)}"><span>${esc(c.name)}${c.doc ? ` · ${esc(c.doc)}` : ''}</span></div>`).join('');
})));
$('#retCustResults').addEventListener('click', (e) => {
  const it = e.target.closest('.item'); if (!it) return;
  ret.customer = { id: Number(it.dataset.rc), name: it.dataset.n };
  $('#retCust').value = ret.customer.name; $('#retCustResults').innerHTML = '';
});
$('#retCancel').addEventListener('click', () => $('#retDialog').close());
$('#retForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = retTotals();
  try {
    const items = Object.entries(ret.back).filter(([, q]) => q > 0).map(([sale_item_id, qty]) => ({ sale_item_id: Number(sale_item_id), qty }));
    const payments = $$('#retPayBox [data-rp]').map((i) => ({ method: i.dataset.rp, amount: Number(i.value) || 0 })).filter((p) => p.amount > 0);
    if (t.due > 0 && !payments.length && !(Number($('#retAcc').value) > 0)) payments.push({ method: 'efectivo', amount: t.due }); // por defecto: efectivo exacto
    if (t.left > 0 && $('#retLeft').value === 'credit' && !ret.customer) throw new Error('Elegí el cliente al que se le deja el saldo a favor');
    const r = await api('POST', '/returns', {
      sale_id: ret.sale.id, items, note: $('#retNote').value, leftover: t.left > 0 ? $('#retLeft').value : undefined, customer_id: ret.customer?.id,
      new_items: ret.fresh.map((l) => ({ article_id: l.a.id, qty: l.qty })), payments, account_amount: Number($('#retAcc').value) || undefined,
    });
    $('#retDialog').close(); toast(r.kind === 'cambio' ? 'Cambio registrado' : 'Devolución registrada');
    await refreshCash(); await loadCash();
    printReturn(r);
  } catch (err) { $('#retError').textContent = err.message; }
});

// ---------- Inicio (panel) ----------
const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
async function loadDashboard() {
  const d = await api('GET', '/dashboard');
  const h = new Date().getHours();
  $('#dashHello').textContent = `${h < 12 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches'}, ${me.user.name.split(' ')[0]}`;
  // Avisos que conviene ver apenas se abre el sistema.
  const alerts = [];
  if (d.update) alerts.push(['warn', `Hay una versión nueva de Liu Vi (${d.update.latest}). Instalala desde la pestaña Copias > Actualizaciones.`]);
  if (d.cash && !d.cash.open) alerts.push(['warn', 'La caja está cerrada.']);
  if (d.backup) {
    if (!d.backup.configured) alerts.push(['bad', 'Todavía no configuraste las copias de seguridad.']);
    else if (d.backup.error) alerts.push(['bad', `La última copia de seguridad falló: ${d.backup.error}`]);
    else if (d.backup.auto && d.backup.last_at && Date.now() - new Date(d.backup.last_at.replace(' ', 'T')).getTime() > 3 * 86_400_000) alerts.push(['warn', `Hace más de 3 días que no se hace una copia de seguridad (última: ${d.backup.last_at}).`]);
  }
  $('#dashAlerts').innerHTML = alerts.map(([k, t]) => `<div class="dash-alert ${k}">${esc(t)}</div>`).join('');
  const diff = d.today.yesterday ? Math.round(((d.today.total - d.today.yesterday) / d.today.yesterday) * 100) : null;
  const kpis = [
    ['Vendido hoy', money(d.today.total), diff === null ? 'ayer sin ventas' : `${diff >= 0 ? '▲' : '▼'} ${Math.abs(diff)}% vs. ayer`],
    ['Ventas de hoy', d.today.sales, d.today.sales ? `ticket prom. ${money(d.today.total / d.today.sales)}` : ''],
  ];
  if (d.today.profit !== null) kpis.push(['Ganancia de hoy', money(d.today.profit), '']);
  if (d.cash?.open) kpis.push(['Efectivo en caja', money(d.cash.expected_cash), `abierta ${time(d.cash.opened_at)}`]);
  if (d.lowStock) kpis.push(['Stock bajo', d.lowStock.count, 'artículos']);
  if (d.debts) kpis.push(['Te deben', money(d.debts.total), `${d.debts.count} cliente${d.debts.count === 1 ? '' : 's'}`]);
  if (d.suppliers) kpis.push(['Le debés a proveedores', money(d.suppliers.total), `${d.suppliers.count} proveedor${d.suppliers.count === 1 ? '' : 'es'}`]);
  if (d.layaways) kpis.push(['Señas abiertas', d.layaways.count, d.layaways.count ? `faltan cobrar ${money(d.layaways.pending)}` : '']);
  $('#dashKpis').innerHTML = kpis.map(([k, v, sub]) => `<div class="kpi"><span>${k}</span><b>${v}</b>${sub ? `<small>${esc(String(sub))}</small>` : ''}</div>`).join('');
  $('#dashWeekCard').hidden = $('#dashTopCard').hidden = !d.week;
  if (d.week) {
    const max = Math.max(1, ...d.week.map((x) => x.total));
    $('#dashWeek').innerHTML = `<div class="chart small">${d.week.map((x) => `<div class="bar" title="${esc(x.day)}: ${money(x.total)}"><small>${money(x.total).replace(/\s/g, '')}</small><i style="height:${Math.round((Math.max(0, x.total) / max) * 85)}%"></i><em>${DAY_NAMES[new Date(x.day + 'T12:00').getDay()]} ${x.day.slice(8)}</em></div>`).join('')}</div><p class="muted" style="margin:8px 0 0">Total de la semana: <b>${money(d.weekTotal)}</b></p>`;
    $('#dashTop tbody').innerHTML = d.top.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.units} u.</td></tr>`).join('') || '<tr><td class="muted">Todavía no hay ventas esta semana</td></tr>';
  }
  $('#dashLowCard').hidden = !d.lowStock;
  if (d.lowStock) $('#dashLow').innerHTML = d.lowStock.items.length
    ? `<table><tbody>${d.lowStock.items.map((a) => `<tr><td>${esc([a.name, a.size && `Talle ${a.size}`, a.color].filter(Boolean).join(' · '))}</td><td class="num">${a.stock} u.</td></tr>`).join('')}</tbody></table>${d.lowStock.count > d.lowStock.items.length ? `<p class="muted" style="margin:8px 0 0">y ${d.lowStock.count - d.lowStock.items.length} más en la pestaña Stock</p>` : ''}`
    : '<span class="muted">Nada con stock bajo 👌</span>';
  $('#dashDebtCard').hidden = !d.debts;
  if (d.debts) $('#dashDebt').innerHTML = d.debts.top.length
    ? `<table><tbody>${d.debts.top.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${money(-c.balance)}</td></tr>`).join('')}</tbody></table>${d.debts.count > d.debts.top.length ? `<p class="muted" style="margin:8px 0 0">y ${d.debts.count - d.debts.top.length} más en Clientes</p>` : ''}`
    : '<span class="muted">Nadie debe nada 👌</span>';
}
$('#dashRefresh').addEventListener('click', guard(loadDashboard));

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

// ---------- Ofertas (en Stock) ----------
const OFFER_STATE = (o) => {
  const t = today();
  if (!o.active) return ['Desactivada', 'muted'];
  if (o.starts_on && o.starts_on > t) return ['Programada', 'muted'];
  if (o.ends_on && o.ends_on < t) return ['Vencida', 'neg'];
  return ['Vigente', 'pos'];
};
async function openOffersList() {
  const list = await api('GET', '/promotions');
  const edit = can('articulos.editar');
  $('#offTable tbody').innerHTML = list.map((o) => {
    const [st, cls] = OFFER_STATE(o);
    const vig = o.starts_on || o.ends_on ? `${o.starts_on ? 'desde ' + o.starts_on : ''}${o.starts_on && o.ends_on ? ' ' : ''}${o.ends_on ? 'hasta ' + o.ends_on : ''}` : 'siempre';
    return `<tr><td><b>${esc(o.name)}</b></td><td>${esc(Promo.describe(o))}</td><td title="${esc(o.article_labels.map((a) => a.label).slice(0, 30).join('\n'))}">${o.article_ids.length}</td><td>${esc(vig)}</td><td class="${cls}">${st}</td>
      <td>${edit ? `<button class="link" data-oedit="${o.id}">Editar</button><button class="link" data-otoggle="${o.id}" data-on="${o.active ? 0 : 1}">${o.active ? 'Desactivar' : 'Activar'}</button><button class="link" data-odel="${o.id}">Borrar</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">Todavía no hay ofertas</td></tr>';
  offersCache = list;
  if (!$('#offListDialog').open) $('#offListDialog').showModal();
}
let offersCache = [];
$('#offManage').addEventListener('click', guard(openOffersList));
$('#sbOffers').addEventListener('change', guard(runStockBrowse));
$('#offListClose').addEventListener('click', () => $('#offListDialog').close());
$('#offTable').addEventListener('click', guard(async (e) => {
  const d = e.target.dataset;
  if (d.oedit) return openOfferDialog(offersCache.find((o) => o.id === Number(d.oedit)));
  if (d.otoggle) {
    try { await api('PUT', '/promotions/' + d.otoggle, { active: d.on === '1' }); } catch (err) { await uiAlert(err.message, 'No se pudo cambiar'); return; }
    await openOffersList(); refreshOffers(true); if (currentTab === 'stock') runStockBrowse();
  }
  if (d.odel && await uiConfirm('¿Borrar esta oferta? Las ventas ya hechas no cambian.', { ok: 'Borrar', danger: true })) { await api('DELETE', '/promotions/' + d.odel); await openOffersList(); refreshOffers(true); if (currentTab === 'stock') runStockBrowse(); }
}));
let offPicked = new Map(), offFound = [], editingOffer = null;
const OFFER_HELP = {
  percent: 'Se descuenta ese porcentaje a cada unidad de los artículos elegidos.',
  price: 'Cada unidad de los artículos elegidos se vende a ese precio (si ya cuesta menos, no cambia).',
  nxm: 'Ej: 2x1 = llevás 2 y pagás 1; 3x2 = llevás 3 y pagás 2. Se combinan entre todos los artículos de la oferta y sale gratis el más barato de cada grupo.',
  second: 'Ej: 50% en la segunda unidad. Por cada dos unidades de la oferta, la más barata lleva ese descuento.',
};
function syncOfferKind() {
  const k = $('#offKind').value;
  $$('#offForm [data-for]').forEach((l) => { l.hidden = !l.dataset.for.split(' ').includes(k); });
  $('#offHelp').textContent = OFFER_HELP[k];
}
$('#offKind').addEventListener('change', syncOfferKind);
function renderOfferPicked() {
  $('#offCount').textContent = `(${offPicked.size})`;
  $('#offPicked tbody').innerHTML = [...offPicked].map(([id, label]) => `<tr><td>${esc(label)}</td><td><button type="button" class="link" data-orm="${id}">Quitar</button></td></tr>`).join('') || '<tr><td colspan="2" class="muted">Todavía no agregaste artículos</td></tr>';
}
async function searchOfferArticles() {
  const q = $('#offSearch').value.trim(), brand = $('#offBrand').value;
  offFound = q || brand ? await api('GET', `/articles?limit=60&q=${encodeURIComponent(q)}${brand ? '&brand_id=' + brand : ''}`) : [];
  $('#offResults tbody').innerHTML = offFound.map((a, i) => `<tr data-opick="${i}" style="cursor:pointer${offPicked.has(a.id) ? ';opacity:.45' : ''}"><td>${esc(articleLabel(a))}</td><td class="num">${money(a.price)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Buscá por nombre o elegí una marca</td></tr>';
}
$('#offSearch').addEventListener('input', debounce(guard(searchOfferArticles)));
$('#offBrand').addEventListener('change', guard(searchOfferArticles));
$('#offResults').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-opick]'); if (!tr) return; const a = offFound[Number(tr.dataset.opick)]; offPicked.set(a.id, articleLabel(a)); renderOfferPicked(); searchOfferArticles(); });
$('#offAddAll').addEventListener('click', guard(async () => {
  const q = $('#offSearch').value.trim(), brand = $('#offBrand').value;
  if (!q && !brand) return setMsg('offError', 'Buscá algo o elegí una marca para agregar todos sus artículos.');
  const all = await api('GET', `/articles?limit=2000&q=${encodeURIComponent(q)}${brand ? '&brand_id=' + brand : ''}`);
  for (const a of all) offPicked.set(a.id, articleLabel(a));
  setMsg('offError', ''); renderOfferPicked(); searchOfferArticles();
}));
$('#offPicked').addEventListener('click', (e) => { if (e.target.dataset.orm) { offPicked.delete(Number(e.target.dataset.orm)); renderOfferPicked(); searchOfferArticles(); } });
async function openOfferDialog(o = null) {
  editingOffer = o?.id ?? null;
  const f = $('#offForm'); f.reset(); setMsg('offError', '');
  $('#offTitle').textContent = o ? 'Editar oferta' : 'Crear oferta';
  const brands = await api('GET', '/brands');
  $('#offBrand').innerHTML = '<option value="">Todas las marcas</option>' + brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $('#offSearch').value = '';
  offPicked = new Map(o ? o.article_ids.map((id) => [id, o.article_labels.find((x) => x.id === id)?.label || `Artículo #${id}`]) : []);
  for (const k of ['name', 'kind', 'pct', 'price', 'buy', 'pay', 'starts_on', 'ends_on']) f.elements[k].value = o ? (o[k] || (k === 'name' || k === 'kind' ? o[k] : '')) : (k === 'kind' ? 'percent' : '');
  syncOfferKind(); renderOfferPicked(); searchOfferArticles();
  if ($('#offListDialog').open) $('#offListDialog').close();
  $('#offDialog').showModal(); f.elements.name.focus();
}
$('#offNew').addEventListener('click', guard(() => openOfferDialog()));
$('#offCancel').addEventListener('click', () => $('#offDialog').close());
$('#offForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { article_ids: [...offPicked.keys()] };
  for (const k of ['name', 'kind', 'pct', 'price', 'buy', 'pay', 'starts_on', 'ends_on']) body[k] = f.elements[k].value;
  try {
    if (editingOffer) await api('PUT', '/promotions/' + editingOffer, body); else await api('POST', '/promotions', body);
    $('#offDialog').close(); toast('Oferta guardada'); refreshOffers(true);
    if (currentTab === 'stock') await runStockBrowse();
  } catch (err) { setMsg('offError', err.message); }
});

// ---------- Proveedores y compras ----------
const owedHtml = (n) => (n > 0.004 ? `<b class="neg">${money(n)}</b>` : n < -0.004 ? `<span class="pos">${money(-n)} a favor</span>` : '<span class="muted">al día</span>');
async function loadSuppliers() {
  const q = encodeURIComponent($('#supSearch').value.trim());
  let rows = await api('GET', `/suppliers?q=${q}`);
  if ($('#supDebt').checked) rows = rows.filter((s) => s.owed > 0.004);
  $('#supTable tbody').innerHTML = rows.map((s) => `<tr data-sid="${s.id}" style="cursor:pointer"><td><b>${esc(s.name)}</b></td><td>${esc(s.phone || '—')}</td>
    <td class="num">${s.purchases_count}</td><td class="num">${money(s.purchases_total)}</td><td>${owedHtml(s.owed)}</td><td>${esc(s.last_purchase || '—')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Todavía no cargaste proveedores</td></tr>';
  const owed = rows.reduce((t, s) => t + Math.max(0, s.owed), 0);
  $('#supNote').textContent = `${rows.length} proveedor(es)${owed > 0.004 ? ` · Les debés ${money(owed)}` : ''}`;
  const edit = can('proveedores.editar');
  $('#supNew').hidden = $('#supBuy').hidden = !edit;
}
$('#supSearch').addEventListener('input', debounce(guard(loadSuppliers)));
$('#supDebt').addEventListener('change', guard(loadSuppliers));
$('#supTable').addEventListener('click', guard(async (e) => { const tr = e.target.closest('tr[data-sid]'); if (tr) await openSupplierDetail(Number(tr.dataset.sid)); }));
let editingSupplier = null;
function openSupplierDialog(s) {
  editingSupplier = s?.id ?? null;
  const f = $('#supForm'); f.reset(); $('#supError').textContent = '';
  $('#supTitle').textContent = s ? 'Editar proveedor' : 'Nuevo proveedor';
  for (const k of ['name', 'phone', 'email', 'note']) f.elements[k].value = s?.[k] ?? '';
  $('#supDialog').showModal(); f.elements.name.focus();
}
$('#supNew').addEventListener('click', () => openSupplierDialog());
$('#supCancel').addEventListener('click', () => $('#supDialog').close());
$('#supForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(e.target));
    const saved = editingSupplier ? await api('PUT', '/suppliers/' + editingSupplier, body) : await api('POST', '/suppliers', body);
    $('#supDialog').close(); toast('Proveedor guardado');
    await loadSuppliers(); if ($('#supDetail').open) await openSupplierDetail(saved.id);
  } catch (err) { $('#supError').textContent = err.message; }
});
let supDetailId = null;
async function openSupplierDetail(id) {
  const s = await api('GET', '/suppliers/' + id);
  supDetailId = id;
  $('#sdName').textContent = s.name;
  $('#sdInfo').textContent = [s.phone, s.email, s.note].filter(Boolean).join(' · ');
  $('#sdKpis').innerHTML = [[s.owed < -0.004 ? 'Saldo a favor' : 'Se le debe', money(Math.abs(s.owed))], ['Compras', s.purchases_count], ['Total comprado', money(s.purchases_total)]].map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
  const edit = can('proveedores.editar');
  $('#sdActions').innerHTML = edit ? `<button class="primary" data-act="buy">Registrar compra</button><button class="ghost" data-act="pay" ${s.owed > 0.004 ? '' : 'disabled'}>Pagar deuda</button><button class="ghost" data-act="edit">Editar datos</button><button class="ghost" data-act="${s.active ? 'off' : 'on'}">${s.active ? 'Dar de baja' : 'Reactivar'}</button>` : '';
  $('#sdActions').onclick = guard(async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    if (act === 'edit') openSupplierDialog(s);
    else if (act === 'buy') openBuyDialog(id);
    else if (act === 'pay') openSupPay(s);
    else if (await uiConfirm(act === 'off' ? `¿Dar de baja a ${s.name}? Su historial se conserva.` : `¿Reactivar a ${s.name}?`, { ok: 'Sí' })) {
      await api('PUT', '/suppliers/' + id, { active: act === 'on' }); await loadSuppliers(); await openSupplierDetail(id);
    }
  });
  $('#sdMovs tbody').innerHTML = s.movements.map((m) => `<tr><td>${esc(m.created_at.slice(0, 16))}</td><td>${esc(m.concept)}${m.from_cash ? ' <small class="muted">(de la caja)</small>' : ''}</td><td class="num ${m.amount < 0 ? 'pos' : 'neg'}">${m.amount < 0 ? '−' : '+'}${money(Math.abs(m.amount))}</td><td>${esc(m.user_name || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin movimientos</td></tr>';
  $('#sdBuys tbody').innerHTML = s.purchases.map((p) => `<tr${p.voided ? ' style="opacity:.55"' : ''}><td>${p.id}</td><td>${esc(p.bought_at)}</td><td>${esc(p.invoice || '—')}</td><td>${p.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</td>
    <td class="num">${p.voided ? `<s>${money(p.total)}</s> <small>anulada</small>` : money(p.total)}</td>
    <td>${edit && !p.voided ? `<button class="link" data-pedit="${p.id}">Editar</button><button class="link" data-pvoid="${p.id}" data-paid="${p.paid}">Anular</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin compras</td></tr>';
  $('#sdBuys').onclick = guard(async (e) => {
    if (e.target.dataset.pedit) return openBuyDialog(id, Number(e.target.dataset.pedit));
    if (e.target.dataset.pvoid) await voidPurchase(Number(e.target.dataset.pvoid), Number(e.target.dataset.paid), id);
  });
  if (!$('#supDetail').open) $('#supDetail').showModal();
}
$('#sdClose').addEventListener('click', () => $('#supDetail').close());
function openSupPay(s) {
  const f = $('#supPayForm'); f.reset(); $('#spError').textContent = '';
  $('#spName').textContent = s.name; $('#spOwed').textContent = `Se le debe ${money(s.owed)}.`;
  f.elements.amount.value = s.owed; f.elements.amount.max = s.owed; $('#spMethodBox').hidden = true;
  f.dataset.id = s.id; $('#supPayDialog').showModal(); f.elements.amount.select();
}
$('#spCash').addEventListener('change', () => { $('#spMethodBox').hidden = !$('#spCash').checked; });
$('#spCancel').addEventListener('click', () => $('#supPayDialog').close());
$('#supPayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', `/suppliers/${f.dataset.id}/payment`, { amount: Number(f.elements.amount.value), from_cash: f.elements.from_cash.checked, method: f.elements.method.value });
    $('#supPayDialog').close(); toast('Pago registrado');
    if (typeof refreshCash === 'function') refreshCash().catch(() => {});
    await loadSuppliers(); await openSupplierDetail(Number(f.dataset.id));
  } catch (err) { $('#spError').textContent = err.message; }
});
// Compra: arma la lista de artículos y, al confirmar, suma el stock y deja la deuda (o el pago) registrada.
let buyLines = [];
let editingPurchase = null;
async function voidPurchase(pid, paid, supplierId) {
  const text = `Se anula la compra #${pid}: sale del stock lo que había entrado y se cancela la deuda.${paid > 0 ? ` Ya se habían pagado ${money(paid)}.` : ''}`;
  const choice = paid > 0
    ? await ask({ title: 'Anular compra', text: text + ' ¿Qué pasa con ese dinero?', stack: true, buttons: [
      { label: 'Queda a favor con el proveedor', value: 'credit', kind: 'primary' }, { label: 'El proveedor me lo devolvió (entra a la caja si salió de ahí)', value: 'refund', kind: 'ghost' }, { label: 'Cancelar', value: null, kind: 'ghost', cancel: true }] })
    : (await uiConfirm(text, { title: 'Anular compra', ok: 'Anular compra', danger: true })) ? 'credit' : null;
  if (!choice) return;
  try {
    await api('POST', `/purchases/${pid}/void`, { refund: choice === 'refund' });
    toast('Compra anulada'); if (typeof refreshCash === 'function') refreshCash().catch(() => {});
    await loadSuppliers(); await openSupplierDetail(supplierId);
  } catch (e) { await uiAlert(e.message, 'No se pudo anular'); }
}
async function openBuyDialog(supplierId, purchaseId = null) {
  editingPurchase = purchaseId;
  const sups = await api('GET', '/suppliers');
  if (!sups.length) return uiAlert('Primero cargá al menos un proveedor.');
  $('#buySupplier').innerHTML = sups.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  if (supplierId) $('#buySupplier').value = supplierId;
  $('#buyInvoice').value = ''; $('#buyDate').value = today(); $('#buySearch').value = ''; $('#buyResults').hidden = true;
  $('#buyPaid').value = 0; $('#buyCash').checked = false; $('#buyMethodBox').hidden = true; $('#buyUpdateCost').checked = true; $('#buyError').textContent = '';
  buyLines = []; renderBuy();
  // Al editar: el proveedor y los pagos ya hechos no se tocan; se corrigen artículos, cantidades, costos y datos.
  $('#buyTitle').textContent = purchaseId ? `Editar compra #${purchaseId}` : 'Registrar compra';
  $('#buySupplier').disabled = !!purchaseId; $('#buyPayBox').hidden = !!purchaseId;
  $('#buySubmit').textContent = purchaseId ? 'Guardar cambios' : 'Registrar compra y sumar stock';
  $('#buyUpdateCost').checked = !purchaseId;
  if (purchaseId) {
    const p = await api('GET', '/purchases/' + purchaseId);
    $('#buySupplier').value = p.supplier_id; $('#buyInvoice').value = p.invoice; $('#buyDate').value = p.bought_at;
    buyLines = p.items.map((i) => ({ a: { id: i.article_id, name: i.name, stock: i.stock }, qty: i.qty, cost: i.cost })); renderBuy();
  }
  $('#buyDialog').showModal(); $('#buySearch').focus();
}
function renderBuy() {
  $('#buyItems tbody').innerHTML = buyLines.map((l, i) => `<tr><td>${esc(articleLabel(l.a))}</td>
    <td><input type="number" min="1" step="1" value="${l.qty}" data-i="${i}" data-f="qty" style="width:80px"></td>
    <td><input type="number" min="0" step="0.01" value="${l.cost}" data-i="${i}" data-f="cost" style="width:110px"></td>
    <td class="num">${money(l.qty * l.cost)}</td><td><button type="button" class="link" data-del="${i}">Quitar</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Todavía no agregaste artículos</td></tr>';
  const total = buyLines.reduce((t, l) => t + l.qty * l.cost, 0);
  $('#buyTotal').textContent = money(total);
  const paid = Number($('#buyPaid').value) || 0;
  $('#buyOwe').textContent = total ? (paid >= total ? 'Queda pagada completa.' : `Queda a deber ${money(total - paid)} a este proveedor.`) : '';
}
$('#supBuy').addEventListener('click', guard(() => openBuyDialog()));
$('#buyItems').addEventListener('input', (e) => {
  const i = e.target.dataset.i; if (i === undefined) return;
  buyLines[i][e.target.dataset.f] = Math.max(0, Number(e.target.value) || 0);
  const tr = e.target.closest('tr'); tr.querySelector('td.num').textContent = money(buyLines[i].qty * buyLines[i].cost);
  const total = buyLines.reduce((t, l) => t + l.qty * l.cost, 0); $('#buyTotal').textContent = money(total);
  const paid = Number($('#buyPaid').value) || 0; $('#buyOwe').textContent = total ? (paid >= total ? 'Queda pagada completa.' : `Queda a deber ${money(total - paid)} a este proveedor.`) : '';
});
$('#buyItems').addEventListener('click', (e) => { if (e.target.dataset.del !== undefined) { buyLines.splice(Number(e.target.dataset.del), 1); renderBuy(); } });
$('#buyPaid').addEventListener('input', renderBuy);
$('#buyCash').addEventListener('change', () => { $('#buyMethodBox').hidden = !$('#buyCash').checked; });
function addBuyArticle(a) {
  const found = buyLines.find((l) => l.a.id === a.id);
  if (found) found.qty++; else buyLines.push({ a, qty: 1, cost: a.cost ?? 0 });
  $('#buySearch').value = ''; $('#buyResults').hidden = true; renderBuy(); $('#buySearch').focus();
}
let buyFound = [];
$('#buySearch').addEventListener('input', debounce(guard(async () => {
  const q = $('#buySearch').value.trim();
  buyFound = q ? await api('GET', '/articles?limit=8&q=' + encodeURIComponent(q)) : [];
  $('#buyResults').hidden = !buyFound.length;
  $('#buyResults').innerHTML = `<table><tbody>${buyFound.map((a, i) => `<tr data-pick="${i}" style="cursor:pointer"><td>${esc(articleLabel(a))}</td><td class="num">stock ${a.stock}</td><td class="num">costo ${money(a.cost)}</td></tr>`).join('')}</tbody></table>`;
})));
$('#buySearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (buyFound[0]) addBuyArticle(buyFound[0]); } });
$('#buyResults').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-pick]'); if (tr) addBuyArticle(buyFound[Number(tr.dataset.pick)]); });
$('#buyCancel').addEventListener('click', () => $('#buyDialog').close());
$('#buyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!buyLines.length) { $('#buyError').textContent = 'Agregá al menos un artículo'; return; }
  try {
    if (editingPurchase) {
      const r = await api('PUT', '/purchases/' + editingPurchase, { invoice: $('#buyInvoice').value, date: $('#buyDate').value, update_cost: $('#buyUpdateCost').checked, items: buyLines.map((l) => ({ article_id: l.a.id, qty: l.qty, cost: l.cost })) });
      $('#buyDialog').close(); toast(`Compra corregida (${money(r.total)})`);
      await loadSuppliers(); await openSupplierDetail(r.supplier_id); return;
    }
    const r = await api('POST', '/purchases', {
      supplier_id: Number($('#buySupplier').value), invoice: $('#buyInvoice').value, date: $('#buyDate').value, update_cost: $('#buyUpdateCost').checked,
      items: buyLines.map((l) => ({ article_id: l.a.id, qty: l.qty, cost: l.cost })), paid_amount: Number($('#buyPaid').value) || 0,
      from_cash: $('#buyCash').checked, method: $('#buyMethod').value,
    });
    $('#buyDialog').close(); toast(`Compra registrada (${money(r.total)}). Stock actualizado.`);
    if (typeof refreshCash === 'function') refreshCash().catch(() => {});
    await loadSuppliers(); if ($('#supDetail').open) await openSupplierDetail(Number($('#buySupplier').value));
  } catch (err) { $('#buyError').textContent = err.message; }
});

// ---------- Reportes ----------
let repLoaded = false, repData = null;
const repCell = (type, v) => (v === '' || v === null || v === undefined ? '' : type === 'money' ? money(v) : type === 'int' ? String(v) : esc(String(v)));
async function loadReports() {
  if (repLoaded) return;
  const kinds = await api('GET', '/reports');
  $('#repKind').innerHTML = kinds.map((k) => `<option value="${k.kind}" data-range="${k.range ? 1 : 0}">${esc(k.label)}</option>`).join('');
  $('#repFrom').value = $('#repTo').value = today();
  repLoaded = true; syncRepRange();
}
const syncRepRange = () => { const r = $('#repKind').selectedOptions[0]?.dataset.range === '1'; $('#repRange').hidden = !r; $('#repPresets').hidden = !r; };
$('#repKind').addEventListener('change', () => { syncRepRange(); $('#repCard').hidden = true; repData = null; });
$('#repPresets').addEventListener('click', (e) => {
  const p = e.target.dataset.p; if (!p) return;
  const day = (d) => d.toLocaleDateString('sv-SE'), n = new Date();
  const ranges = {
    today: [n, n], yesterday: [new Date(n - 86_400_000), new Date(n - 86_400_000)], week: [new Date(n - 6 * 86_400_000), n],
    month: [new Date(n.getFullYear(), n.getMonth(), 1), n], lastmonth: [new Date(n.getFullYear(), n.getMonth() - 1, 1), new Date(n.getFullYear(), n.getMonth(), 0)],
    year: [new Date(n.getFullYear(), 0, 1), n],
  };
  [$('#repFrom').value, $('#repTo').value] = ranges[p].map(day);
});
const repQuery = () => `from=${$('#repFrom').value}&to=${$('#repTo').value}`;
async function viewReport() {
  $('#repError').textContent = '';
  try {
    repData = await api('GET', `/reports/${$('#repKind').value}?${repQuery()}`);
  } catch (e) { $('#repError').textContent = e.message; return null; }
  const r = repData;
  $('#repCard').hidden = false;
  $('#repTitle').textContent = r.title; $('#repSub').textContent = r.subtitle;
  $('#repTable thead').innerHTML = `<tr>${r.columns.map((c) => `<th${c.type === 'text' ? '' : ' class="num"'}>${esc(c.label)}</th>`).join('')}</tr>`;
  const cells = (row, b) => `<tr${b ? ' class="tot"' : ''}>${row.map((v, i) => `<td${r.columns[i].type === 'text' ? '' : ' class="num"'}>${b && r.columns[i].type !== 'text' ? '<b>' + repCell(r.columns[i].type, v) + '</b>' : b ? '<b>' + esc(String(v)) + '</b>' : repCell(r.columns[i].type, v)}</td>`).join('')}</tr>`;
  $('#repTable tbody').innerHTML = r.rows.map((row) => cells(row)).join('') || `<tr><td class="muted" colspan="${r.columns.length}">No hay datos en este período</td></tr>`;
  $('#repTable tfoot').innerHTML = r.rows.length && r.totals ? cells(r.totals, true) : '';
  $('#repCount').textContent = `${r.rows.length} fila${r.rows.length === 1 ? '' : 's'}`;
  return r;
}
$('#repView').addEventListener('click', guard(viewReport));
$('#repXlsx').addEventListener('click', guard(async () => {
  $('#repError').textContent = '';
  const res = await fetch(`/api/reports/${$('#repKind').value}/xlsx?${repQuery()}`);
  if (!res.ok) { $('#repError').textContent = (await res.json().catch(() => null))?.error || 'No se pudo generar el Excel'; return; }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'reporte.xlsx';
  const url = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}));
$('#repPrint').addEventListener('click', guard(async () => {
  const r = await viewReport(); if (!r) return;
  const th = r.columns.map((c) => `<th style="text-align:${c.type === 'text' ? 'left' : 'right'}">${esc(c.label)}</th>`).join('');
  const row = (cells, b) => `<tr>${cells.map((v, i) => `<td style="text-align:${r.columns[i].type === 'text' ? 'left' : 'right'};${b ? 'font-weight:700;border-top:2px solid #000' : ''}">${repCell(r.columns[i].type, v)}</td>`).join('')}</tr>`;
  const html = `<div style="font:11px Arial,sans-serif;color:#000"><h2 style="margin:0 0 2px;font-size:18px">Liu Vi · ${esc(r.title)}</h2><div style="margin:0 0 10px;color:#444">${esc(r.subtitle)}</div>
    <table style="border-collapse:collapse;width:100%"><thead><tr style="background:#eee">${th}</tr></thead><tbody>${r.rows.map((x) => row(x)).join('')}</tbody>${r.totals ? `<tfoot>${row(r.totals, true)}</tfoot>` : ''}</table></div>
    <style>#printArea td,#printArea th{padding:3px 5px;border-bottom:1px solid #ccc}#printArea thead{display:table-header-group}#printArea tr{break-inside:avoid}</style>`;
  await printHtml(html, `size:${pageName()} ${r.columns.length > 7 ? 'landscape' : 'portrait'};margin:10mm`);
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
    : row(methodName(p.method), money(p.amount)))).join('') + (s.account_amount ? row('Cuenta del cliente', money(s.account_amount)) : '');
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
    ${s.discount || s.surcharge ? row('Subtotal', money(s.subtotal)) + saleDiscounts(s).map(([l, v]) => row(esc(l), '-' + money(v))).join('') + (s.surcharge ? row('Recargo', '+' + money(s.surcharge)) : '') : ''}
    ${row('TOTAL', money(s.total), 'tot')}
    <hr>${pays}
    <hr><div class="c">${esc(settings.footer)}</div>
    <div class="c" style="font-size:10px">Comprobante no válido como factura</div>
    ${copy ? `<div class="c b" style="font-size:10px">${copy}</div>` : ''}
  </div>`;
}

// Comprobante para hoja A4/Carta. Una copia = una mitad; con pocos artículos entran las dos en la misma hoja.
function comprobanteHtml(s, copy) {
  const pay = [...s.payments.map((p) => `${methodName(p.method)} ${money(p.amount + (p.method === 'efectivo' ? s.change || 0 : 0))}`),
    ...(s.account_amount ? [`Cuenta del cliente ${money(s.account_amount)}`] : [])].join(' · ');
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
      ${s.discount || s.surcharge ? `<div>Subtotal: ${money(s.subtotal)}</div>${saleDiscounts(s).map(([l, v]) => `<div>${esc(l)}: -${money(v)}</div>`).join('')}${s.surcharge ? `<div>Recargo: +${money(s.surcharge)}</div>` : ''}` : ''}
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
// Descuentos de una venta: cada oferta por separado y, aparte, el descuento manual.
function saleDiscounts(s) {
  let det = s.promo_detail; if (typeof det === 'string') { try { det = JSON.parse(det); } catch { det = []; } }
  det = Array.isArray(det) ? det : [];
  const manual = r2((s.discount || 0) - (s.promo_discount || 0));
  return [...det.map((d) => [`Oferta: ${d.name}`, d.amount]), ...(manual > 0 ? [['Descuento', manual]] : [])];
}
function printDocument(doc, { ticket, comp, count }) {
  const copies = COPIES[settings.copies] || COPIES.both;
  if (settings.paper === '58' || settings.paper === '80') {
    const html = copies.map((c, i) => `<div${i ? ' class="pb"' : ''}>${ticket(doc, c)}</div>`).join('');
    return printHtml(html, `size:${settings.paper}mm auto;margin:3mm`);
  }
  const together = count <= 10;
  const html = copies.map((c, i) => `${i ? (together ? '<div class="cut">✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>' : '') : ''}<div class="${i && !together ? 'pb' : ''}">${comp(doc, c)}</div>`).join('');
  return printHtml(html, `size:${pageName()} portrait;margin:10mm`);
}
const printTicket = (s) => printDocument(s, { ticket: ticketHtml, comp: comprobanteHtml, count: s.items.length });

// Comprobante de cambio / devolución (no fiscal): qué se devolvió, qué se llevó y cómo se resolvió la diferencia.
const returnLines = (r) => {
  const out = [['Valor de lo devuelto', money(r.value)]];
  if (r.new_items.length) out.push(['Prendas nuevas', money(r.new_sale.total)], ['Cubierto con lo devuelto', money(r.exchange_amount)]);
  const paid = r.new_sale ? r.new_sale.total - r.exchange_amount : 0;
  if (paid > 0) out.push(['Diferencia pagada por el cliente', money(paid)]);
  if (r.refund_cash) out.push([`Dinero devuelto (${r.refund_method})`, money(r.refund_cash)]);
  if (r.credit_amount) out.push(['Saldo a favor del cliente', money(r.credit_amount)]);
  return out;
};
const returnTitle = (r) => (r.kind === 'cambio' ? 'COMPROBANTE DE CAMBIO' : 'COMPROBANTE DE DEVOLUCIÓN');
function returnTicketHtml(r, copy) {
  const w = { 58: '48mm', 80: '72mm' }[settings.paper] || '80mm';
  const row = (a, b, cls = '') => `<div class="r ${cls}"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="ticket" style="width:${w}">
    <img class="logo" src="/img/logo-tinta.png" alt="Liu Vi" style="width:${w === '48mm' ? '30mm' : '40mm'}">
    ${settings.name ? `<div class="c b" style="font-size:14px">${esc(settings.name)}</div>` : ''}
    ${settings.cuit ? `<div class="c">CUIT ${esc(settings.cuit)}${settings.iva ? ' · ' + esc(settings.iva) : ''}</div>` : ''}
    <div class="c b">${returnTitle(r)}</div>
    <div class="c">${esc(when(r))} · N° D-${String(r.id).padStart(8, '0')}</div>
    <div class="c">Corresponde a la venta ${compNumber({ id: r.sale_id })}</div>
    ${r.customer_name ? `<div class="c">Cliente: ${esc(r.customer_name)}</div>` : ''}
    <hr><div class="b">Devuelve</div>
    ${r.items.map((i) => `<div>${esc(i.name)}</div>` + row(`${i.qty} x ${money(i.price)}`, money(i.qty * i.price))).join('')}
    ${r.new_items.length ? `<hr><div class="b">Se lleva</div>${r.new_items.map((i) => `<div>${esc(i.name)}</div>` + row(`${i.qty} x ${money(i.price)}`, money(i.qty * i.price))).join('')}` : ''}
    <hr>${returnLines(r).map(([a, b]) => row(a, b)).join('')}
    <hr><div class="c" style="font-size:10px">Comprobante no válido como factura</div>
    ${copy ? `<div class="c b" style="font-size:10px">${copy}</div>` : ''}
  </div>`;
}
function returnCompHtml(r, copy) {
  const table = (title, rows) => `<table><thead><tr><th>${title}</th><th>Cant.</th><th>Precio unit.</th><th>Subtotal</th></tr></thead><tbody>
    ${rows.map((i) => `<tr><td>${esc(i.name)}</td><td class="n">${i.qty}</td><td class="n">${money(i.price)}</td><td class="n">${money(i.qty * i.price)}</td></tr>`).join('')}</tbody></table>`;
  return `<div class="comp">
    <div class="ch">
      <div class="cl"><img src="/img/logo-tinta.png" alt="Liu Vi" style="width:38mm;height:auto">
        ${settings.name ? `<b>${esc(settings.name)}</b>` : ''}${settings.info ? `<div>${esc(settings.info)}</div>` : ''}
        ${settings.cuit ? `<div>CUIT: ${esc(settings.cuit)}</div>` : ''}${settings.iva ? `<div>Condición IVA: ${esc(settings.iva)}</div>` : ''}</div>
      <div class="cx"><b>X</b><small>Documento no válido como factura</small></div>
      <div class="cr"><b>${returnTitle(r).replace('COMPROBANTE DE ', '')}</b><div>N° D-${String(r.id).padStart(8, '0')}</div><div>Fecha: ${esc(when(r))}</div>
        <div>Venta original: ${compNumber({ id: r.sale_id })}</div>${r.user_name ? `<div>Atendió: ${esc(r.user_name)}</div>` : ''}<div class="copy">${copy}</div></div>
    </div>
    <div class="cc"><span>Cliente: <b>${esc(r.customer_name || 'Consumidor final')}</b></span>${r.customer_doc ? `<span>DNI/CUIT: <b>${esc(r.customer_doc)}</b></span>` : ''}</div>
    ${table('Devuelve', r.items)}${r.new_items.length ? table('Se lleva', r.new_items) : ''}
    <div class="ct">${returnLines(r).map(([a, b], i, all) => `<div${i === all.length - 1 ? ' class="tot"' : ''}>${a}: ${b}</div>`).join('')}</div>
    ${r.note ? `<div class="cf">Nota: ${esc(r.note)}</div>` : ''}
    <div class="cf">${esc(settings.footer)}</div>
  </div>`;
}
// Comprobante de seña / pago de un apartado (no fiscal).
const layLines = (l) => [...l.payments.map((p) => [`Pago ${p.created_at.slice(0, 10)} (${p.method === 'cuenta' ? 'saldo a favor' : p.method})`, money(p.amount)]),
  ['Total pagado hasta hoy', money(l.paid)], ['Falta pagar', money(l.remaining)]];
function layTicketHtml(l, copy) {
  const w = { 58: '48mm', 80: '72mm' }[settings.paper] || '80mm';
  const row = (a, b, cls = '') => `<div class="r ${cls}"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="ticket" style="width:${w}">
    <img class="logo" src="/img/logo-tinta.png" alt="Liu Vi" style="width:${w === '48mm' ? '30mm' : '40mm'}">
    ${settings.name ? `<div class="c b" style="font-size:14px">${esc(settings.name)}</div>` : ''}
    <div class="c b">COMPROBANTE DE SEÑA</div><div class="c">N° A-${String(l.id).padStart(8, '0')} · ${esc((l.created_at || '').slice(0, 10))}</div>
    <div class="c">Cliente: ${esc(l.customer_name)}</div><hr><div class="b">Mercadería apartada</div>
    ${l.items.map((i) => `<div>${esc(i.name)}</div>` + row(`${i.qty} x ${money(i.price)}`, money(i.qty * i.price))).join('')}
    <hr>${row('TOTAL', money(l.total), 'tot')}<hr>${layLines(l).map(([a, b]) => row(a, b)).join('')}
    <hr><div class="c" style="font-size:10px">La mercadería queda reservada a nombre del cliente hasta completar el pago. Comprobante no válido como factura.</div>
    ${copy ? `<div class="c b" style="font-size:10px">${copy}</div>` : ''}</div>`;
}
function layCompHtml(l, copy) {
  return `<div class="comp"><div class="ch">
    <div class="cl"><img src="/img/logo-tinta.png" alt="Liu Vi" style="width:38mm;height:auto">${settings.name ? `<b>${esc(settings.name)}</b>` : ''}${settings.info ? `<div>${esc(settings.info)}</div>` : ''}${settings.cuit ? `<div>CUIT: ${esc(settings.cuit)}</div>` : ''}</div>
    <div class="cx"><b>X</b><small>Documento no válido como factura</small></div>
    <div class="cr"><b>SEÑA</b><div>N° A-${String(l.id).padStart(8, '0')}</div><div>Fecha: ${esc((l.created_at || '').slice(0, 16))}</div>${l.user_name ? `<div>Atendió: ${esc(l.user_name)}</div>` : ''}<div class="copy">${copy}</div></div></div>
    <div class="cc"><span>Cliente: <b>${esc(l.customer_name)}</b></span>${l.customer_doc ? `<span>DNI/CUIT: <b>${esc(l.customer_doc)}</b></span>` : ''}</div>
    <table><thead><tr><th>Mercadería apartada</th><th>Cant.</th><th>Precio unit.</th><th>Subtotal</th></tr></thead><tbody>
      ${l.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="n">${i.qty}</td><td class="n">${money(i.price)}</td><td class="n">${money(i.qty * i.price)}</td></tr>`).join('')}</tbody></table>
    <div class="ct"><div>Total: ${money(l.total)}</div>${layLines(l).map(([a, b], i, all) => `<div${i === all.length - 1 ? ' class="tot"' : ''}>${a}: ${b}</div>`).join('')}</div>
    ${l.note ? `<div class="cf">Nota: ${esc(l.note)}</div>` : ''}
    <div class="cf">La mercadería queda reservada a nombre del cliente hasta completar el pago. El precio queda fijo desde hoy.</div></div>`;
}
const printLayaway = (l) => printDocument(l, { ticket: layTicketHtml, comp: layCompHtml, count: l.items.length + l.payments.length + 4 });
const printReturn = (r) => printDocument(r, { ticket: returnTicketHtml, comp: returnCompHtml, count: r.items.length + r.new_items.length + 4 });
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
  if (e.target.dataset.rdel !== undefined && await uiConfirm('Los usuarios con este rol deben reasignarse antes.', { title: '¿Eliminar este rol?', ok: 'Eliminar', danger: true })) { await api('DELETE', '/roles/' + card.dataset.role); toast('Rol eliminado'); return loadUsers(); }
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
const G_LOGO = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 6.7-9.9 6.7-17.4z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.6 2.3-8.6 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';
function renderGoogle(g) {
  const box = $('#gdBox');
  if (!g) { box.innerHTML = ''; return; }
  const err = g.error ? `<p class="neg">${esc(g.error)}</p>` : '';
  if (g.connected) {
    box.innerHTML = `<p>✅ Conectado a Google Drive${g.email ? ` como <b>${esc(g.email)}</b>` : ''}.<br>Las copias se suben a la carpeta <b>${esc(g.folder)}</b> de tu Drive.</p>
      <p class="muted">${g.last_at ? `Última subida: <b>${esc(g.last_at)}</b> (${esc(g.last_name)})` : 'Todavía no se subió ninguna copia. Se sube sola con cada copia (una por día y al cerrar la caja).'}</p>${err}
      <div class="row"><button type="button" id="gdRun" class="primary">Hacer copia y subirla ahora</button><button type="button" id="gdOff" class="ghost">Desconectar cuenta</button></div>`;
  } else if (g.configured) {
    box.innerHTML = `<p>Vinculá tu cuenta de Google para guardar las copias en tu Drive. Se abre la ventana de Google: elegís tu cuenta, tocás <b>Permitir</b> y listo.</p>${err}
      <div class="row"><button type="button" id="gdOn" class="gBtn">${G_LOGO}<span>Conectar con Google</span></button>${g.credentials_from === 'propias' ? '<button type="button" id="gdCreds" class="link">Cambiar credenciales</button>' : ''}</div>
      <p class="muted" style="margin-top:6px">Solo accede a la carpeta de copias que crea este sistema; no ve el resto de tu Drive.</p>`;
  } else {
    box.innerHTML = `<p><b>Falta un paso inicial</b> (una sola vez): Google necesita que este programa tenga sus credenciales. Los pasos están en <b>LEEME-GOOGLE-DRIVE.md</b>. Cuando bajes el archivo <code>.json</code> de Google Cloud, importalo acá y aparece el botón «Conectar con Google».</p>${err}
      <div class="row"><label class="gFile ghost">Importar archivo de Google (.json)<input type="file" id="gdFile" accept=".json,application/json" hidden></label></div>
      <div id="gdCredErr" class="neg"></div>
      <details style="margin-top:8px"><summary class="muted">Escribir el ID y el secreto a mano</summary>
        <form id="gdCredForm"><label>ID de cliente <input name="id" placeholder="123456-abc.apps.googleusercontent.com" required></label>
        <label>Secreto de cliente <input name="secret" type="password" autocomplete="off" required></label>
        <button class="primary">Guardar credenciales</button></form></details>`;
  }
}
// Conectar: se abre una ventanita de Google (como «Acceder con Google»); mientras tanto esta pantalla espera el resultado.
let gdWatch = null;
async function connectGoogle() {
  const w = window.open('', 'liuvi-google', 'popup=yes,width=520,height=720'); // se abre ya, dentro del clic, para que no la bloquee el navegador
  try {
    const { url } = await api('POST', '/backup/google/start', { popup: !!w });
    if (!w) { location.href = url; return; }
    w.location.href = url;
    clearInterval(gdWatch);
    const t0 = Date.now();
    gdWatch = setInterval(guard(async () => {
      const b = await api('GET', '/backup');
      if (b.google?.connected || Date.now() - t0 > 5 * 60_000 || (w.closed && Date.now() - t0 > 3000)) {
        clearInterval(gdWatch);
        try { if (b.google?.connected) w.close(); } catch { /* ya se cerró */ }
        renderBackup(b);
        if (b.google?.connected) toast('Google Drive conectado');
      }
    }), 1500);
  } catch (e) { try { w?.close(); } catch { /* nada */ } throw e; }
}
function renderBackup(b) {
  $('#bkDir').value = b.custom_dir ? b.dir : ''; $('#bkDir').placeholder = b.default_dir || 'C:\\Users\\Mi nombre\\Mi unidad\\Liuvi';
  $('#bkPc').value = b.pc_name || ''; $('#bkAuto').checked = b.auto; $('#bkError').textContent = '';
  renderSchedule(b); renderRestore(b);
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
async function loadBackup() { renderBackup(await api('GET', '/backup')); if (can('usuarios.admin')) await loadUpdate(); else $('#updCard').hidden = true; }
// Actualizaciones del programa
function renderUpdate(u) {
  $('#updCard').hidden = false;
  $('#updAuto').checked = u.auto;
  $('#updCheck').disabled = !u.enabled || u.busy; $('#updAuto').disabled = !u.enabled;
  $('#updApply').hidden = !u.available;
  $('#updInfo').textContent = !u.enabled ? `Versión instalada: ${u.version}. Las actualizaciones automáticas funcionan en el programa instalado con el instalador de Windows.`
    : u.available ? `Hay una versión nueva: ${u.latest} (tenés la ${u.version}).`
    : `Versión instalada: ${u.version}${u.latest ? ' · es la última' : ''}${u.checked_at ? ` · revisado ${u.checked_at.slice(0, 16)}` : ''}`;
  $('#updNote').textContent = u.error ? `No se pudo buscar: ${u.error}` : u.available ? 'Al actualizar se hace una copia de seguridad, se instala la versión nueva y el sistema se reinicia solo (unos segundos). Tus datos no se tocan.' : '';
}
async function loadUpdate() { renderUpdate(await api('GET', '/update')); }
$('#updCheck').addEventListener('click', guard(async () => {
  const b = $('#updCheck'); b.disabled = true; b.textContent = 'Buscando…';
  try { renderUpdate(await api('POST', '/update/check', {})); } catch (e) { $('#updNote').textContent = 'No se pudo buscar: ' + e.message; } finally { b.textContent = 'Buscar actualizaciones'; b.disabled = false; }
}));
$('#updAuto').addEventListener('change', guard(async () => { renderUpdate(await api('PUT', '/update', { auto: $('#updAuto').checked })); }));
$('#updApply').addEventListener('click', guard(async () => {
  if (!(await uiConfirm('Se instala la versión nueva y el sistema se reinicia solo (tarda unos segundos). Antes se hace una copia de seguridad de tus datos. Si estás cobrando, esperá a terminar.', { title: 'Actualizar Liu Vi', ok: 'Actualizar ahora' }))) return;
  const b = $('#updApply'); b.disabled = true; b.textContent = 'Actualizando…';
  try {
    const r = await api('POST', '/update/apply', {});
    $('#updNote').textContent = `Listo: se instaló la ${r.to}. Reiniciando…`;
    // Cuando el sistema vuelve (ya en la versión nueva), se recarga la pantalla.
    const t0 = Date.now();
    const wait = setInterval(async () => {
      if (Date.now() - t0 > 90_000) { clearInterval(wait); $('#updNote').textContent = 'El sistema tarda en volver. Cerrá y abrí Liu Vi desde el acceso directo.'; return; }
      try { const m = await (await fetch('/api/auth/me', { cache: 'no-store' })).json(); if (m.version === r.to) { clearInterval(wait); location.reload(); } } catch { /* reiniciando */ }
    }, 1500);
  } catch (e) { $('#updNote').textContent = 'No se pudo actualizar: ' + e.message; b.disabled = false; b.textContent = 'Actualizar ahora'; }
}));
// Horarios: «veces por día» más un horario editable para cada una.
const COUNTS = [1, 2, 3, 4, 6, 8, 12, 24];
function defaultTimes(n) {
  if (n === 1) return ['22:00'];
  if (n >= 24) return Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const step = 840 / (n - 1); // entre las 8 y las 22
  return Array.from({ length: n }, (_, i) => { const m = Math.round((480 + step * i) / 5) * 5; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; });
}
function renderTimes(times) {
  $('#bkTimes').innerHTML = times.map((t, i) => `<input type="time" value="${t}" data-bt="${i}" aria-label="Copia ${i + 1}" required>`).join('');
  $('#bkCount').innerHTML = [...new Set([...COUNTS, times.length])].sort((a, b) => a - b).map((n) => `<option value="${n}"${n === times.length ? ' selected' : ''}>${n}</option>`).join('');
  updateKeepHint();
}
const currentTimes = () => $$('#bkTimes input').map((i) => i.value).filter(Boolean);
function updateKeepHint() {
  const per = Math.max(1, $$('#bkTimes input').length), keep = Number($('#bkKeep').value) || 30;
  $('#bkKeepHint').textContent = `(alcanza para unos ${Math.max(1, Math.round(keep / per))} día${Math.round(keep / per) === 1 ? '' : 's'} de copias)`;
}
function renderSchedule(b) {
  renderTimes(b.times || ['22:00']);
  $('#bkOnClose').checked = b.on_close !== false;
  $('#bkKeep').innerHTML = [...new Set([10, 30, 60, 100, 200, 500, b.keep || 30])].sort((x, y) => x - y).map((n) => `<option value="${n}"${n === (b.keep || 30) ? ' selected' : ''}>${n}</option>`).join('');
  $('#bkSched').hidden = !b.auto;
  const n = b.next_at;
  $('#bkNext').textContent = n ? `Próxima copia automática: ${n.slice(0, 10) === new Date().toLocaleDateString('sv-SE') ? 'hoy' : 'mañana'} a las ${n.slice(11)}` : '';
  updateKeepHint();
}
$('#bkAuto').addEventListener('change', () => { $('#bkSched').hidden = !$('#bkAuto').checked; });
$('#bkCount').addEventListener('change', () => {
  const n = Number($('#bkCount').value), cur = currentTimes();
  renderTimes(n < cur.length ? cur.slice(0, n) : n === cur.length ? cur : [...cur, ...defaultTimes(n).filter((t) => !cur.includes(t))].slice(0, n).sort());
});
$('#bkKeep').addEventListener('change', updateKeepHint);
const bkBody = () => ({ dir: $('#bkDir').value, auto: $('#bkAuto').checked, pc_name: $('#bkPc').value, times: currentTimes(), on_close: $('#bkOnClose').checked, keep: Number($('#bkKeep').value) });

// Restaurar una copia: se pide escribir RESTAURAR; los datos se reemplazan y se vuelve a la pantalla de acceso.
const sizeKb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function renderRestore(b) {
  $('#rsLocal tbody').innerHTML = (b.restore_files || []).map((f) => `<tr><td>${esc(f.name)}${f.kind === 'previa' ? '<br><span class="rsPrevia">Copia de tus datos justo antes de una restauración</span>' : ''}</td><td>${esc(f.at)}</td><td class="num">${sizeKb(f.size)}</td>
    <td><button class="link" data-rslocal="${esc(f.name)}">Restaurar</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Todavía no hay copias en la carpeta</td></tr>';
  $('#rsDriveBtn').hidden = !b.google?.connected;
  if (!b.google?.connected) $('#rsDrive').hidden = true;
}
async function confirmRestore(what, payload) {
  const word = await uiPrompt(`Vas a reemplazar TODOS los datos actuales (artículos, ventas, clientes, usuarios y caja) por los de:\n${what}\n\nAntes se guarda una copia de lo que hay hoy y se cierra la sesión.\n\nPara confirmar, escribí RESTAURAR.`, '', { title: '¿Restaurar esta copia?', ok: 'Restaurar' });
  if (word === null) return;
  if (word.trim().toUpperCase() !== 'RESTAURAR') return toast('No se restauró nada: hay que escribir RESTAURAR', true);
  toast('Restaurando…');
  const r = await api('POST', '/backup/restore', { ...payload, confirm: 'RESTAURAR' });
  await uiAlert(`Datos restaurados.\nAhora hay ${r.now.articles} artículo(s), ${r.now.sales} venta(s) y ${r.now.users} usuario(s).\nSe guardó una copia de lo anterior: ${r.safety_file.split(/[\\/]/).pop()}\n\nIniciá sesión de nuevo.`, 'Restauración lista');
  location.reload();
}
$('#rsLocal').addEventListener('click', guard(async (e) => { const n = e.target.dataset.rslocal; if (n) await confirmRestore(`la copia ${n}`, { source: 'local', name: n }); }));
$('#rsFile').addEventListener('change', guard(async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 24 * 1024 * 1024) throw new Error('El archivo es demasiado grande (máximo 24 MB)');
  const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
  await confirmRestore(`el archivo ${f.name}`, { source: 'upload', data });
}));
$('#rsDriveBtn').addEventListener('click', guard(async () => {
  const list = await api('GET', '/backup/drive-list');
  $('#rsDrive').hidden = false;
  $('#rsDriveTable tbody').innerHTML = list.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.pc)}</td><td>${esc((f.created_at || '').slice(0, 16).replace('T', ' '))}</td><td class="num">${sizeKb(f.size)}</td>
    <td><button class="link" data-rsdrive="${esc(f.id)}" data-n="${esc(f.name)}">Restaurar</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No hay copias en tu Drive todavía</td></tr>';
}));
$('#rsDriveTable').addEventListener('click', guard(async (e) => { const id = e.target.dataset.rsdrive; if (id) await confirmRestore(`la copia ${e.target.dataset.n} (de Google Drive)`, { source: 'drive', id }); }));
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
  if (e.target.closest('#gdOn')) return connectGoogle();
  if (id === 'gdRun') await backupNow();
  if (id === 'gdOff' && await uiConfirm('Las copias que ya están en tu Drive no se borran.', { title: '¿Desconectar Google Drive?', ok: 'Desconectar', danger: true })) { renderBackup(await api('POST', '/backup/google/disconnect', {})); toast('Google Drive desconectado'); }
  if (id === 'gdCreds') renderGoogle({ configured: false });
}));
$('#gdBox').addEventListener('change', guard(async (e) => {
  if (e.target.id !== 'gdFile' || !e.target.files[0]) return;
  const text = await e.target.files[0].text();
  try { renderBackup(await api('PUT', '/backup/google/credentials', { json: text })); toast('Credenciales importadas: ya podés conectar tu cuenta'); }
  catch (err) { $('#gdCredErr').textContent = err.message; }
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

// Aviso «Respaldando» (abajo a la izquierda): consulta al servidor cada pocos segundos mientras hay sesión.
let bbTimer = null;
async function pollBackup() {
  const bar = $('#backupBar');
  if (document.hidden) return; // ventana minimizada o en segundo plano: no hace falta consultar
  try {
    if (!me?.user || !$('#login').hidden) { bar.hidden = true; return; }
    const st = await api('GET', '/backup/activity');
    bar.hidden = !st.show;
    bar.classList.toggle('done', st.show && !st.busy && st.ok);
    bar.classList.toggle('fail', st.show && !st.busy && !st.ok);
    $('#bbText').textContent = st.busy ? `Respaldando… ${st.phase ? '· ' + st.phase : ''}` : st.ok ? 'Respaldo listo ✓' : 'No se pudo respaldar';
    bar.title = st.error || '';
  } catch { /* sin conexión o sesión bloqueada: se reintenta */ }
}
function startBackupWatch() { clearInterval(bbTimer); pollBackup(); bbTimer = setInterval(pollBackup, 3000); }

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
  appReady = true; startIdleWatch(); startBackupWatch();
  document.body.classList.toggle('nocost', !can('costos.ver'));
  $('#adjCard').hidden = !can('stock.ajustar');
  $('#clearCard').hidden = !can('stock.limpiar');
  $('#artNew').hidden = $('#artImport').hidden = $('#artPrices').hidden = !can('articulos.editar');
  let first = null;
  $$('#tabs button').forEach((b) => { const t = tabOfButton(b); b.hidden = !t; if (t && !first) first = t; });
  renderPayLines(); renderCart();
  if (!first) return toast('Tu usuario no tiene permisos asignados. Pedile a un administrador que configure tu rol.', true);
  await guard(refreshCash)();
  const wanted = location.hash.slice(1);
  showTab(wanted && TAB_PERMS[wanted] && canAny(...TAB_PERMS[wanted]) ? wanted : first);
  if (wanted) history.replaceState(null, '', location.pathname);
}
boot().catch((e) => toast(e.message, true));
