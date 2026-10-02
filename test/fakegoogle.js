import { createServer } from 'node:http';

// Google de mentira: mismos pasos que la API real (token, userinfo, carpetas, subida resumible, borrado, revocación).
export async function fakeGoogle() {
  const st = { files: [], seq: 0, tokens: [], revoked: 0, badRefresh: false, expires: 3600, uploads: {} };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = (code, o, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    const authed = req.headers.authorization === 'Bearer at-good' || url.pathname.startsWith('/upload/session/'); // la URL de sesión de Google se autoriza sola
    if (url.pathname === '/token') {
      const f = new URLSearchParams(raw.toString());
      st.tokens.push(Object.fromEntries(f));
      if (f.get('grant_type') === 'authorization_code') return f.get('code_verifier') && f.get('client_secret') === 'sec' ? json(200, { access_token: 'at-good', refresh_token: 'rt-1', expires_in: st.expires }) : json(400, { error: 'invalid_request' });
      if (st.badRefresh) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: 'at-good', expires_in: st.expires });
    }
    if (url.pathname === '/auth') { // «el usuario elige su cuenta y permite»: Google vuelve al sistema con el código
      res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=c&state=${url.searchParams.get('state')}` }); return res.end();
    }
    if (url.pathname === '/revoke') { st.revoked++; return json(200, {}); }
    if (!authed) return json(401, { error: { message: 'no auth' } });
    if (url.pathname === '/userinfo') return json(200, { email: 'dueña@gmail.com' });
    if (url.pathname === '/drive/files' && req.method === 'GET') {
      const q = url.searchParams.get('q');
      const name = /name='([^']*)'/.exec(q)?.[1], parent = /'([^']*)' in parents/.exec(q)?.[1];
      let list = st.files.filter((f) => !f.trashed && (name === undefined || f.name === name) && (parent === undefined || f.parents?.includes(parent)));
      if (!name) list = list.sort((a, b) => b.n - a.n);
      return json(200, { files: list.map((f) => ({ id: f.id, name: f.name, size: String(f.size ?? 0), createdTime: new Date(1.7e12 + f.n * 1000).toISOString() })) });
    }
    if (url.pathname === '/drive/files' && req.method === 'POST') { const b = JSON.parse(raw); const f = { id: `f${++st.seq}`, n: st.seq, ...b }; st.files.push(f); return json(200, { id: f.id }); }
    if (url.pathname.startsWith('/drive/files/') && req.method === 'GET') {
      const f = st.files.find((x) => x.id === url.pathname.split('/').pop());
      if (!f) return json(404, { error: { message: 'no existe' } });
      if (url.searchParams.get('alt') === 'media') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(f.data || Buffer.alloc(0)); }
      return json(200, { name: f.name, size: String(f.size ?? 0) });
    }
    if (url.pathname.startsWith('/drive/files/') && req.method === 'DELETE') { st.files = st.files.filter((f) => f.id !== url.pathname.split('/').pop()); res.writeHead(204); return res.end(); }
    if (url.pathname === '/upload/files') {
      const b = JSON.parse(raw); const id = `u${++st.seq}`; st.uploads[id] = b;
      return json(200, {}, { Location: `http://127.0.0.1:${server.address().port}/upload/session/${id}` });
    }
    if (url.pathname.startsWith('/upload/session/')) {
      const id = url.pathname.split('/').pop(); const meta = st.uploads[id];
      st.files.push({ id, n: ++st.seq, name: meta.name, parents: meta.parents, size: raw.length, data: raw });
      return json(200, { id });
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { st, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
