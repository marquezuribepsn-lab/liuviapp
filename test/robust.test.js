import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start } from './helpers.js';

const rawGet = (base, path) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

test('direcciones raras o rotas no tiran abajo el servidor', async () => {
  const t = await start();
  try {
    for (const path of ['//', '/%', '/api/%E0%A4%A', '/../../etc/passwd', '/api/articles/%00', '//evil.com/x']) {
      const r = await rawGet(t.base, path);
      assert.ok(r.status >= 200 && r.status < 500, `${path} → ${r.status}`);
    }
    assert.equal((await rawGet(t.base, '//')).status, 400, 'la dirección inválida se rechaza con un 400');
    // El servidor sigue respondiendo después de todo eso
    assert.equal((await t.client().call('GET', '/api/auth/me')).status, 200);
  } finally { t.close(); }
});
