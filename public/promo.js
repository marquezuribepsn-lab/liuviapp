// Cálculo de ofertas (lo usan el servidor, que es quien manda, y la pantalla de venta para mostrar el total antes de cobrar).
// offer: { id, name, kind: 'percent'|'price'|'nxm'|'second', pct, price, buy, pay, article_ids: [] }
// lines: [{ article_id, price, qty }]
(() => {
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const MAX_UNITS = 5000;

  function unitsOf(offer, lines) {
    const set = new Set(offer.article_ids);
    const prices = [];
    for (const l of lines) {
      if (!set.has(l.article_id)) continue;
      for (let i = 0; i < l.qty && prices.length < MAX_UNITS; i++) prices.push(l.price);
    }
    return prices.sort((a, b) => b - a); // de la más cara a la más barata
  }

  // Cuánto se descuenta por esta oferta en estas líneas.
  function discountOf(offer, lines) {
    const u = unitsOf(offer, lines);
    let d = 0;
    if (offer.kind === 'percent') d = u.reduce((s, p) => s + (p * offer.pct) / 100, 0);
    else if (offer.kind === 'price') d = u.reduce((s, p) => s + Math.max(0, p - offer.price), 0);
    else if (offer.kind === 'nxm') {
      const groups = Math.floor(u.length / offer.buy);
      for (let g = 0; g < groups; g++) for (let i = g * offer.buy + offer.pay; i < (g + 1) * offer.buy; i++) d += u[i]; // las más baratas de cada grupo salen gratis
    } else if (offer.kind === 'second') {
      for (let k = 0; k < Math.floor(u.length / 2); k++) d += (u[2 * k + 1] * offer.pct) / 100; // la segunda (más barata) de cada par
    }
    return r2(d);
  }

  function apply(offers, lines) {
    const detail = [];
    for (const o of offers) {
      const amount = discountOf(o, lines);
      if (amount > 0) detail.push({ id: o.id, name: o.name, amount });
    }
    return { total: r2(detail.reduce((s, x) => s + x.amount, 0)), detail };
  }

  const inForce = (o, today) => !!o.active && (!o.starts_on || o.starts_on <= today) && (!o.ends_on || today <= o.ends_on);

  function describe(o) {
    if (o.kind === 'percent') return `${o.pct}% de descuento`;
    if (o.kind === 'price') return `Precio fijo $${o.price}`;
    if (o.kind === 'nxm') return `${o.buy}x${o.pay} (llevás ${o.buy}, pagás ${o.pay})`;
    return `2da unidad con ${o.pct}% de descuento`;
  }

  globalThis.Promo = { discountOf, apply, inForce, describe };
})();
