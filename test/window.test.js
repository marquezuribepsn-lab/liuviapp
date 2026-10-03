import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('latido de la ventana: avisa al programa y no cuenta como actividad del usuario', async () => {
  const seen = [];
  const t = await start({ onWindow: (k) => seen.push(k) });
  try {
    for (const kind of ['ping', 'bye']) {
      const res = await fetch(`${t.base}/api/window/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    }
    assert.deepEqual(seen, ['ping', 'bye']);
    // sin el encabezado JSON se rechaza (defensa contra formularios de otros sitios)
    const bad = await fetch(`${t.base}/api/window/ping`, { method: 'POST', body: 'x' });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});
