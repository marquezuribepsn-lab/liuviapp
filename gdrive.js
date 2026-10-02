import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { basename, join } from 'node:path';
import { hostname } from 'node:os';
import { APP_DIR, getSetting, setSetting } from './db.js';

// Copias en Google Drive de la propia persona: inicia sesión con su cuenta (OAuth, "app de escritorio") y el
// sistema sube cada copia a «Liu Vi - Copias / <nombre de la computadora>». Solo ve lo que él mismo creó
// (permiso drive.file): no puede leer ni tocar el resto del Drive.
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const ROOT_NAME = 'Liu Vi - Copias';
const KEEP_REMOTE = 30;
const PENDING_MS = 10 * 60_000;
const KEYS = ['google_client_id', 'google_client_secret', 'google_refresh_token', 'google_email', 'google_root_id', 'google_pc_id', 'google_pc_name',
  'google_last_at', 'google_last_name', 'google_error'];

const endpoints = (base) => (base
  ? { auth: `${base}/auth`, token: `${base}/token`, api: `${base}/drive`, upload: `${base}/upload`, userinfo: `${base}/userinfo`, revoke: `${base}/revoke` }
  : {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', api: 'https://www.googleapis.com/drive/v3',
    upload: 'https://www.googleapis.com/upload/drive/v3', userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo', revoke: 'https://oauth2.googleapis.com/revoke',
  });

const b64url = (buf) => buf.toString('base64url');
const q = (s) => String(s).replaceAll('\\', '\\\\').replaceAll("'", "\\'");

export const computerName = () => (hostname() || 'Computadora').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60) || 'Computadora';

export function createGoogleDrive(db, { base, keep = KEEP_REMOTE, clientFile = join(APP_DIR, 'google-client.json') } = {}) {
  const ep = endpoints(base);
  const get = (k, d = '') => getSetting(db, k, d);
  const set = (k, v) => setSetting(db, k, v);
  const pending = new Map();           // state -> { verifier, redirect, exp }
  let access = null;                   // { token, exp }
  let chain = Promise.resolve();

  // Credenciales: las que cargó el administrador, o las que vienen con el programa (google-client.json).
  function creds() {
    const id = get('google_client_id'), secret = get('google_client_secret');
    if (id && secret) return { id, secret, source: 'propias' };
    try {
      const f = JSON.parse(readFileSync(clientFile, 'utf8'));
      const c = f.installed || f;
      if (c.client_id && c.client_secret) return { id: c.client_id, secret: c.client_secret, source: 'programa' };
    } catch { /* sin archivo */ }
    return null;
  }

  const pcName = () => get('backup_pc_name') || computerName();
  const connected = () => !!get('google_refresh_token');

  function status() {
    const c = creds();
    return {
      configured: !!c, credentials_from: c?.source || null, connected: connected(), email: get('google_email') || null,
      folder: connected() ? `${ROOT_NAME} / ${pcName()}` : null,
      last_at: get('google_last_at') || null, last_name: get('google_last_name') || null, error: get('google_error') || null,
    };
  }

  function saveCredentials({ client_id, client_secret }) {
    const id = String(client_id ?? '').trim(), secret = String(client_secret ?? '').trim();
    if (!id || !secret) throw new Error('Completá el ID de cliente y el secreto');
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('El ID de cliente debería terminar en .apps.googleusercontent.com');
    disconnectLocal();
    set('google_client_id', id); set('google_client_secret', secret);
  }

  async function call(url, opts = {}, ms = 60_000) {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let j = null; try { j = JSON.parse(text); } catch { /* texto plano */ }
      const err = new Error(j?.error_description || j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || `Google respondió ${res.status}`);
      err.status = res.status; err.code = typeof j?.error === 'string' ? j.error : j?.error?.status;
      throw err;
    }
    return res;
  }
  const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

  function authUrl(redirect) {
    const c = creds();
    if (!c) throw new Error('Primero cargá las credenciales de Google (ID de cliente y secreto)');
    for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
    const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(24));
    pending.set(state, { verifier, redirect, exp: Date.now() + PENDING_MS });
    const p = new URLSearchParams({
      client_id: c.id, redirect_uri: redirect, response_type: 'code', scope: SCOPES, state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'consent',
    });
    return `${ep.auth}?${p}`;
  }

  // Vuelta desde Google: el "state" es de un solo uso y solo lo conoce quien inició la conexión desde el sistema.
  async function finish(state, code) {
    const p = pending.get(state);
    pending.delete(state);
    if (!p || p.exp < Date.now()) throw new Error('El pedido de conexión venció. Volvé a tocar «Conectar con Google».');
    const c = creds();
    if (!c) throw new Error('Faltan las credenciales de Google');
    const tok = await (await call(ep.token, form({
      client_id: c.id, client_secret: c.secret, code, code_verifier: p.verifier, redirect_uri: p.redirect, grant_type: 'authorization_code',
    }))).json();
    if (!tok.refresh_token) throw new Error('Google no entregó el permiso permanente. Quitá el acceso de «Liu Vi» en tu cuenta de Google y conectá de nuevo.');
    let email = '';
    try { email = (await (await call(ep.userinfo, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()).email || ''; } catch { /* es solo informativo */ }
    for (const k of ['google_root_id', 'google_pc_id', 'google_pc_name', 'google_error']) set(k, '');
    set('google_refresh_token', tok.refresh_token); set('google_email', email);
    access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  }

  async function token() {
    if (access && access.exp > Date.now()) return access.token;
    const c = creds(), refresh = get('google_refresh_token');
    if (!c || !refresh) throw new Error('Google Drive no está conectado');
    try {
      const t = await (await call(ep.token, form({ client_id: c.id, client_secret: c.secret, refresh_token: refresh, grant_type: 'refresh_token' }))).json();
      access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
      return access.token;
    } catch (e) {
      if (e.code === 'invalid_grant') { // revocado o vencido: hay que volver a conectar
        set('google_refresh_token', ''); access = null;
        throw new Error('La conexión con Google venció o fue revocada. Volvé a conectar tu cuenta.');
      }
      throw e;
    }
  }

  const auth = async () => ({ Authorization: `Bearer ${await token()}` });

  async function folder(name, parent) {
    const headers = await auth();
    const query = `name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parent ? ` and '${q(parent)}' in parents` : ''}`;
    const list = await (await call(`${ep.api}/files?${new URLSearchParams({ q: query, fields: 'files(id)', pageSize: '1' })}`, { headers })).json();
    if (list.files?.[0]) return list.files[0].id;
    const made = await (await call(`${ep.api}/files?fields=id`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent && { parents: [parent] }) }),
    })).json();
    return made.id;
  }

  async function pcFolder() {
    const name = pcName();
    if (get('google_pc_id') && get('google_pc_name') === name) return get('google_pc_id');
    const root = get('google_root_id') || await folder(ROOT_NAME);
    set('google_root_id', root);
    const id = await folder(name, root);
    set('google_pc_id', id); set('google_pc_name', name);
    return id;
  }

  async function sendFile(file, parent) {
    const headers = await auth();
    const size = statSync(file).size;
    const start = await call(`${ep.upload}/files?uploadType=resumable&fields=id`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name: basename(file), parents: [parent] }),
    });
    const loc = start.headers.get('location');
    if (!loc) throw new Error('Google no aceptó iniciar la subida');
    await call(loc, { method: 'PUT', headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' }, body: createReadStream(file), duplex: 'half' }, 600_000);
  }

  async function prune(parent) {
    const headers = await auth();
    const query = `'${q(parent)}' in parents and trashed=false`;
    const list = await (await call(`${ep.api}/files?${new URLSearchParams({ q: query, orderBy: 'createdTime desc', fields: 'files(id)', pageSize: '200' })}`, { headers })).json();
    for (const f of (list.files || []).slice(keep)) { try { await call(`${ep.api}/files/${f.id}`, { method: 'DELETE', headers }); } catch { /* se borra la próxima vez */ } }
  }

  async function upload(file) {
    if (!connected()) return;
    if (!existsSync(file)) throw new Error('No se encontró la copia para subir');
    try {
      let parent = await pcFolder();
      try { await sendFile(file, parent); }
      catch (e) { // la carpeta pudo borrarse o moverse: se vuelve a crear una vez
        if (e.status !== 404) throw e;
        set('google_pc_id', ''); set('google_root_id', '');
        parent = await pcFolder(); await sendFile(file, parent);
      }
      set('google_last_at', new Date().toLocaleString('sv-SE')); set('google_last_name', basename(file)); set('google_error', '');
      await prune(parent);
    } catch (e) {
      set('google_error', `${new Date().toLocaleString('sv-SE')} · ${e.message}`);
      throw e;
    }
  }

  // Las subidas van de a una y nunca frenan lo que está haciendo el usuario.
  function enqueue(file) {
    if (!connected()) return Promise.resolve();
    chain = chain.then(() => upload(file)).catch((e) => console.error('Subida a Google Drive fallida:', e.message));
    return chain;
  }

  function disconnectLocal() { for (const k of KEYS) set(k, ''); access = null; pending.clear(); }
  async function disconnect() {
    const c = creds(), t = get('google_refresh_token');
    for (const k of KEYS.filter((k) => !['google_client_id', 'google_client_secret'].includes(k))) set(k, '');
    access = null; pending.clear();
    if (t) { try { await call(ep.revoke, form({ token: t }), 15_000); } catch { /* ya estaba revocado o sin internet: igual queda desconectado acá */ } }
    return c;
  }

  return { status, saveCredentials, authUrl, finish, enqueue, idle: () => chain, disconnect, connected, pcName, STRIP_KEYS: KEYS };
}
