// Actualización del programa: baja la versión nueva desde GitHub (solo el código; tus datos y la conexión con Google no se tocan),
// la prueba aparte y recién entonces reemplaza la anterior. La versión previa queda guardada en «.update/anterior».
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, renameSync, openSync } from 'node:fs';
import { join, dirname, normalize, sep } from 'node:path';
import { readZip } from './xlsx.js';

export const DEFAULT_REPO = { owner: 'marquezuribepsn-lab', repo: 'liuviapp', branch: 'main' };
const CHECK_EVERY_MS = 6 * 3600_000;
// Lo que nunca se reemplaza ni se instala desde la actualización.
const SKIP_TOP = new Set(['test', 'installer', '.github', '.git', '.update', 'runtime', 'shell', 'electron', 'google-client.json', 'iniciar.bat', 'iniciar.command', '.gitignore', '.gitattributes', 'node_modules']);

export const parseVersion = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim()); return m ? m.slice(1).map(Number) : null; };
export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function createUpdater(db, { appDir, version, enabled = false, repo = DEFAULT_REPO, fetchFn = fetch, restart = null, beforeApply = null, urls = null, now = Date.now } = {}) {
  const get = (k, d = '') => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
  const set = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const u = urls || {
    version: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.branch}/package.json`,
    zip: `https://codeload.github.com/${repo.owner}/${repo.repo}/zip/refs/heads/${repo.branch}`,
  };
  let busy = false;

  const auto = () => get('update_auto', '1') === '1';
  function status() {
    const latest = get('update_latest') || null;
    return {
      enabled, version, auto: auto(), latest, available: enabled && isNewer(latest, version),
      checked_at: get('update_checked_at') || null, error: get('update_error') || null, busy,
      previous: existsSync(join(appDir, '.update', 'anterior')),
    };
  }
  function configure({ auto: a }) { if (a !== undefined) set('update_auto', a === false ? '0' : '1'); }

  async function check() {
    if (!enabled) throw new Error('Las actualizaciones solo funcionan en el programa instalado');
    try {
      const res = await fetchFn(u.version, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
      const latest = JSON.parse(await res.text()).version;
      if (!parseVersion(latest)) throw new Error('No se pudo leer la versión nueva');
      set('update_latest', latest); set('update_checked_at', new Date().toLocaleString('sv-SE')); set('update_error', '');
    } catch (e) {
      const msg = e.name === 'TimeoutError' || /fetch failed/i.test(e.message) ? 'No se pudo conectar (¿hay internet?)' : e.message;
      set('update_error', msg); set('update_checked_at', new Date().toLocaleString('sv-SE'));
      throw new Error(msg);
    }
    return status();
  }

  // Extrae a una carpeta de prueba solo lo que es del programa.
  function extract(buf, dest) {
    const zip = readZip(buf);
    const names = zip.names();
    const root = names.find((n) => n.endsWith('/') && n.split('/').length === 2) ?? names[0]?.split('/')[0] + '/';
    if (!root) throw new Error('El archivo descargado está vacío');
    let files = 0;
    for (const name of names) {
      if (!name.startsWith(root) || name.endsWith('/')) continue;
      const rel = normalize(name.slice(root.length));
      if (!rel || rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) continue; // nada fuera de la carpeta
      if (SKIP_TOP.has(rel.split(sep)[0])) continue;
      const target = join(dest, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, zip.read(name));
      files++;
    }
    return files;
  }

  // La versión nueva tiene que poder arrancar: sintaxis de cada archivo y una base en memoria.
  function verify(dir, expected) {
    for (const f of ['server.js', 'app.js', 'db.js', 'package.json', 'public/index.html', 'public/app.js']) if (!existsSync(join(dir, f))) throw new Error(`La actualización está incompleta (falta ${f})`);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.version !== expected) throw new Error('La versión descargada no es la esperada');
    // Si la versión nueva pide un Node más nuevo que el que trae el programa instalado, hace falta el instalador completo.
    const need = /(\d+)\.(\d+)/.exec(pkg.engines?.node || '');
    if (need) {
      const [maj, min] = process.versions.node.split('.').map(Number);
      if (maj < Number(need[1]) || (maj === Number(need[1]) && min < Number(need[2]))) throw new Error(`Esta versión necesita un motor más nuevo (Node ${need[1]}.${need[2]}): instalala con el instalador completo (Liu-Vi-Setup)`);
    }
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--check', join(dir, f)], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`La actualización tiene un error en ${f}`);
    }
    const smoke = "const {openDb}=await import('./db.js');const {createApp}=await import('./app.js');createApp(openDb(':memory:'));process.exit(0)";
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', smoke], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error('La actualización no pasó la prueba de arranque: ' + (r.stderr || '').split('\n').find((l) => /Error/.test(l)));
  }

  // Reemplaza los archivos del programa; si algo falla en el medio, deja todo como estaba.
  function swap(staging, backupDir) {
    rmSync(backupDir, { recursive: true, force: true });
    mkdirSync(backupDir, { recursive: true });
    const moved = [];
    try {
      for (const item of readdirSync(staging)) {
        const cur = join(appDir, item);
        if (existsSync(cur)) { renameSync(cur, join(backupDir, item)); moved.push([item, true]); } else moved.push([item, false]);
        renameSync(join(staging, item), cur);
      }
      // Archivos del programa que ya no existen en la versión nueva (por ejemplo, un módulo viejo) se retiran.
      for (const item of readdirSync(appDir)) {
        if (!/\.js$/.test(item) || existsSync(join(staging, item)) || moved.some(([m]) => m === item)) continue;
        renameSync(join(appDir, item), join(backupDir, item)); moved.push([item, null]);
      }
    } catch (e) {
      for (const [item, had] of moved.reverse()) {
        try { rmSync(join(appDir, item), { recursive: true, force: true }); } catch { /* sigue */ }
        if (had !== false) try { renameSync(join(backupDir, item), join(appDir, item)); } catch { /* sigue */ }
      }
      throw new Error('No se pudo reemplazar los archivos: ' + e.message);
    }
  }

  async function apply() {
    if (!enabled) throw new Error('Las actualizaciones solo funcionan en el programa instalado');
    if (busy) throw new Error('Ya se está actualizando');
    busy = true;
    try {
      const st = await check();
      if (!st.available) throw new Error('Ya tenés la última versión');
      const res = await fetchFn(u.zip, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`No se pudo descargar la actualización (GitHub respondió ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 60 * 1024 * 1024) throw new Error('La descarga es demasiado grande');
      const work = join(appDir, '.update');
      const staging = join(work, 'nueva');
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      try {
        if (extract(buf, staging) < 5) throw new Error('El archivo descargado no parece el programa');
        verify(staging, st.latest);
        await beforeApply?.(); // copia de seguridad de los datos
        swap(staging, join(work, 'anterior'));
      } finally { rmSync(staging, { recursive: true, force: true }); }
      set('update_applied', `${version} → ${st.latest} · ${new Date().toLocaleString('sv-SE')}`);
      return { updated: true, from: version, to: st.latest };
    } finally { busy = false; }
  }

  // Revisa al abrir y cada tanto, sin molestar: solo avisa que hay versión nueva.
  function start() {
    if (!enabled) return;
    const tick = () => { if (auto()) check().catch(() => {}); };
    setTimeout(tick, 20_000).unref();
    setInterval(tick, CHECK_EVERY_MS).unref();
  }
  const relaunch = () => restart?.();
  return { status, configure, check, apply, start, relaunch, isNewer };
}

// Reinicia el sistema ya actualizado: un proceso auxiliar espera a que éste suelte el puerto y levanta el nuevo.
export function relaunchServer({ appDir, closeServer, port = Number(process.env.PORT) || 3000, env = process.env } = {}) {
  const logFile = env.LIUVI_LOGFILE;
  let out = 'ignore';
  try { if (logFile) out = openSync(logFile, 'a'); } catch { /* sin registro */ }
  const childEnv = { ...env, LIUVI_OPEN: '0' }; // la ventana que ya está abierta se recarga sola
  const script = `
    const net = require('net'), { spawn } = require('child_process');
    const [dir, port] = [process.argv[1], Number(process.argv[2])];
    let tries = 0;
    const launch = () => { spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: dir, detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, env: process.env }).unref(); setTimeout(() => process.exit(0), 300); };
    const check = () => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); if (++tries < 40) setTimeout(check, 500); else launch(); }); s.on('error', launch); };
    setTimeout(check, 700);`;
  const helper = spawn(process.execPath, ['-e', script, appDir, String(port)], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: childEnv });
  helper.unref();
  setTimeout(() => { try { closeServer?.(); } catch { /* ya cerrado */ } process.exit(0); }, 500);
}
