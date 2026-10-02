import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, readdirSync, unlinkSync, accessSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { computerName } from './gdrive.js';
import { migrateRoles, dataSummary } from './db.js';

const KEEP = 30;                       // copias que se conservan por defecto
const KEEP_SAFETY = 10;                // copias «antes de restaurar» que se conservan
const FILE_RE = /^liuvi-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.db$/;
const SAFETY_RE = /^liuvi-antes-de-restaurar-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.db$/;
const DEFAULT_TIMES = ['22:00'];
const REQUIRED_TABLES = ['users', 'roles', 'articles', 'sales', 'settings', 'cash_sessions'];

const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');
// Hora local armada a mano (no depende del idioma/ICU de cada instalación).
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

// Horarios de las copias automáticas: lista de «HH:MM» sin repetir y ordenada.
export function normalizeTimes(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(String).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort();
}
// El último horario programado que ya pasó («AAAA-MM-DD HH:MM»): si el sistema estuvo apagado, se hace una sola copia de repaso.
export function latestSlot(now, times) {
  const past = times.filter((t) => t <= hm(now));
  if (past.length) return `${ymd(now)} ${past.at(-1)}`;
  return `${ymd(new Date(now.getTime() - 86_400_000))} ${times.at(-1)}`;
}
export function nextSlot(now, times) {
  const later = times.find((t) => t > hm(now));
  return later ? `${ymd(now)} ${later}` : `${ymd(new Date(now.getTime() + 86_400_000))} ${times[0]}`;
}

// defaultDir: carpeta propia de esta computadora (junto a la base de datos) cuando no se eligió otra.
export function createBackups(db, { gdrive = null, defaultDir = null } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const get = (k, d = '') => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
  const set = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  const customDir = () => get('backup_dir');
  const dirOf = () => customDir() || defaultDir || '';
  function ensureDir(dir) { if (dir && dir === defaultDir && !customDir()) mkdirSync(dir, { recursive: true }); }

  function checkDir(dir) {
    if (!isAbsolute(dir)) throw new Error('Indicá la ruta completa de la carpeta (por ejemplo C:\\Users\\Mi nombre\\Mi unidad\\Liuvi)');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('La carpeta no existe. Crearla primero (dentro de Google Drive).');
    try { accessSync(dir, constants.W_OK); } catch { throw new Error('No se puede escribir en esa carpeta'); }
  }

  const files = (dir, re = FILE_RE) => (dir && existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().reverse() : []);
  const getTimes = () => { const t = normalizeTimes(get('backup_times')); return t.length ? t : DEFAULT_TIMES; };
  const keepCount = () => { const n = Math.round(Number(get('backup_keep'))); return n >= 5 && n <= 1000 ? n : KEEP; };
  const uniqueName = (dir, prefix) => {
    let name = `${prefix}-${stamp()}.db`;
    for (let i = 2; existsSync(join(dir, name)); i++) name = `${prefix}-${stamp()}-${i}.db`;
    return name;
  };

  function prune(dir) {
    for (const f of files(dir).slice(keepCount())) { try { unlinkSync(join(dir, f)); } catch { /* en uso: se borra en la próxima */ } }
    for (const f of files(dir, SAFETY_RE).slice(KEEP_SAFETY)) { try { unlinkSync(join(dir, f)); } catch { /* idem */ } }
  }

  // Copia consistente aun con el sistema en uso; se verifica antes de darla por buena.
  function makeCopy(file) {
    db.prepare('VACUUM INTO ?').run(file);
    // La conexión con Google es de esta computadora: no viaja dentro de la copia (ni queda en Drive ni en otra PC).
    const strip = new DatabaseSync(file);
    try {
      strip.exec("DELETE FROM settings WHERE key LIKE 'google\\_%' ESCAPE '\\'");
      strip.exec('VACUUM'); // que no queden restos de las credenciales en páginas libres
    } finally { strip.close(); }
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('La copia no pasó la verificación');
    } finally { copy.close(); }
  }

  // Estado visible en pantalla: la copia local es instantánea, así que el aviso se mantiene unos segundos y mientras sube a Drive.
  const activity = { active: 0, reason: '', phase: '', until: 0, ok: true, error: '', seq: 0 };
  const SHOW_MS = 6000;
  function begin(reason, phase) { activity.active++; activity.reason = reason; activity.phase = phase; activity.until = Date.now() + SHOW_MS; activity.seq++; }
  function end(ok, error = '') { activity.active = Math.max(0, activity.active - 1); activity.ok = ok; activity.error = error; activity.until = Date.now() + SHOW_MS; }
  function activityStatus() {
    check(); // el aviso de la pantalla también sirve de latido: si el reloj interno se retrasó, se pone al día
    const busy = activity.active > 0, recent = Date.now() < activity.until;
    return { busy, show: busy || (recent && activity.seq > 0), phase: busy ? activity.phase : '', reason: activity.reason, ok: activity.ok, error: activity.error, seq: activity.seq };
  }

  function run(reason = 'manual') {
    begin(reason, 'Copiando los datos');
    try { return runInner(reason); }
    catch (e) { end(false, e.message); throw e; }
  }
  function runInner(reason) {
    const dir = dirOf();
    if (!dir) throw new Error('Primero elegí la carpeta de copias');
    ensureDir(dir);
    checkDir(dir);
    const file = join(dir, uniqueName(dir, 'liuvi-backup'));
    try { makeCopy(file); }
    catch (e) {
      try { unlinkSync(file); } catch { /* no se llegó a crear */ }
      set('backup_error', `${new Date().toLocaleString('sv-SE')} · ${e.message}`);
      throw e;
    }
    set('backup_last_at', new Date().toLocaleString('sv-SE'));
    set('backup_last_file', file);
    set('backup_last_reason', reason);
    set('backup_error', '');
    prune(dir);
    if (gdrive?.status().connected) {
      activity.phase = 'Subiendo a Google Drive';
      activity.active++; // la subida sigue después de devolver la copia local
      Promise.resolve(gdrive.enqueue(file)).then(() => end(true), (e) => end(false, e.message));
    }
    end(true);
    return file;
  }

  // Para disparos automáticos: nunca debe romper lo que está haciendo el usuario.
  function tryRun(reason) {
    if (!dirOf() || get('backup_auto', '1') !== '1') return null;
    if (reason === 'cierre de caja' && get('backup_on_close', '1') !== '1') return null;
    try { return run(reason); } catch (e) { console.error('Copia de seguridad fallida:', e.message); return null; }
  }

  function status() {
    const dir = dirOf();
    return {
      db_file: db.prepare('PRAGMA database_list').get()?.file || null,
      dir, custom_dir: !!customDir(), default_dir: defaultDir, pc_name: get('backup_pc_name') || computerName(),
      google: gdrive ? gdrive.status() : null, auto: get('backup_auto', '1') === '1',
      last_at: get('backup_last_at') || null, last_file: get('backup_last_file') || null,
      last_reason: get('backup_last_reason') || null, error: get('backup_error') || null,
      files: files(dir).slice(0, 10).map((name) => { const st = statSync(join(dir, name)); return { name, size: st.size, at: st.mtime.toLocaleString('sv-SE') }; }),
      times: getTimes(), on_close: get('backup_on_close', '1') === '1', keep: keepCount(),
      next_at: get('backup_auto', '1') === '1' && dir ? nextSlot(new Date(), getTimes()) : null,
      restore_files: restorable(dir),
    };
  }
  // Copias de esta computadora que se pueden restaurar (las normales y las que se hicieron justo antes de restaurar).
  function restorable(dir) {
    const out = [];
    for (const [re, kind] of [[FILE_RE, 'copia'], [SAFETY_RE, 'previa']]) {
      for (const name of files(dir, re)) { const st = statSync(join(dir, name)); out.push({ name, kind, size: st.size, at: st.mtime.toLocaleString('sv-SE') }); }
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60);
  }

  function configure({ dir, auto, pc_name, times, on_close, keep }) {
    const d = dir === undefined ? null : String(dir).trim(); // sin «dir» no se toca la carpeta elegida
    if (d) checkDir(d);
    let ts = null;
    if (times !== undefined) {
      ts = normalizeTimes(times);
      if (!ts.length) throw new Error('Poné al menos un horario para las copias automáticas (formato HH:MM)');
      if (ts.length > 24) throw new Error('Como máximo 24 copias por día');
    }
    let k = null;
    if (keep !== undefined) {
      k = Math.round(Number(keep));
      if (!(k >= 5 && k <= 1000)) throw new Error('Cuántas copias conservar: entre 5 y 1000');
    }
    if (d !== null) set('backup_dir', d);
    if (pc_name !== undefined) {
      const n = String(pc_name).trim().replace(/[\\/:*?"<>|']/g, '').slice(0, 60);
      set('backup_pc_name', n === computerName() ? '' : n);
    }
    if (auto !== undefined) set('backup_auto', auto === false ? '0' : '1');
    if (ts) { set('backup_times', JSON.stringify(ts)); set('backup_last_slot', latestSlot(new Date(), ts)); } // cambiar los horarios no dispara una copia al instante
    if (on_close !== undefined) set('backup_on_close', on_close === false ? '0' : '1');
    if (k !== null) set('backup_keep', k);
  }

  // Copias programadas: se revisa cada minuto. Si el sistema estuvo apagado en un horario, al encender se hace una copia de repaso.
  let retryAfter = 0;
  function check(now = new Date()) {
    if (!dirOf() || get('backup_auto', '1') !== '1' || now.getTime() < retryAfter) return null;
    const slot = latestSlot(now, getTimes());
    if (get('backup_last_slot') >= slot) return null;
    const file = tryRun('programada');
    if (file) set('backup_last_slot', slot);
    else retryAfter = now.getTime() + 10 * 60_000; // no se pudo (carpeta ausente, etc.): reintenta en 10 minutos
    return file;
  }
  function start() {
    setTimeout(() => check(), 5000).unref();
    setInterval(() => check(), 60_000).unref();
  }

  // ---------- Restaurar ----------
  // Se comprueba que sea de verdad una copia de Liu Vi, íntegra y con usuarios (una copia vacía borraría todo).
  function validateBackup(path) {
    const bad = () => new Error('El archivo no es una copia válida de Liu Vi');
    let c;
    try { c = new DatabaseSync(path, { readOnly: true }); } catch { throw bad(); }
    try {
      let ok; try { ok = c.prepare('PRAGMA integrity_check').get().integrity_check; } catch { throw bad(); }
      if (ok !== 'ok') throw new Error('El archivo está dañado: no pasó la verificación de integridad');
      const tables = new Set(c.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
      if (REQUIRED_TABLES.some((t) => !tables.has(t))) throw new Error('El archivo no es una copia de Liu Vi (faltan datos del sistema)');
      if (!c.prepare('SELECT COUNT(*) AS n FROM users').get().n) throw new Error('Esa copia no tiene usuarios (está vacía): no se restaura para no borrar tus datos');
      const n = (t) => (tables.has(t) ? c.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
      return { users: n('users'), articles: n('articles'), sales: n('sales'), customers: n('customers') };
    } finally { c.close(); }
  }
  // Reemplaza los datos actuales por los de la copia, todo o nada. Antes se guarda una copia de lo que hay ahora.
  // Se conservan los ajustes de esta computadora (carpeta de copias, conexión con Google) y se cierran todas las sesiones.
  function restoreFromFile(src) {
    const preview = validateBackup(src);
    const dir = dirOf();
    if (!dir) throw new Error('Primero elegí la carpeta de copias: ahí se guarda una copia de seguridad de tus datos actuales antes de restaurar');
    ensureDir(dir); checkDir(dir);
    const safety = join(dir, uniqueName(dir, 'liuvi-antes-de-restaurar'));
    try { makeCopy(safety); } catch (e) { try { unlinkSync(safety); } catch { /* nada */ } throw new Error(`No se restauró nada: no se pudo guardar la copia previa de tus datos (${e.message})`); }
    const tmp = join(dir, `.restaurando-${Date.now()}.db`);
    copyFileSync(src, tmp); // se trabaja sobre una copia: el archivo original no se toca
    try {
      db.prepare('ATTACH DATABASE ? AS bk').run(tmp);
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec('PRAGMA defer_foreign_keys = ON');
          const q = (n) => `"${String(n).replaceAll('"', '""')}"`;
          const live = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
          const theirs = new Set(db.prepare("SELECT name FROM bk.sqlite_master WHERE type='table'").all().map((r) => r.name));
          const mine = "key LIKE 'backup\\_%' ESCAPE '\\' OR key LIKE 'google\\_%' ESCAPE '\\'";
          for (const t of live) {
            if (t === 'settings') {
              db.exec(`DELETE FROM main.settings WHERE NOT (${mine})`);
              if (theirs.has('settings')) db.exec(`INSERT OR IGNORE INTO main.settings (key,value) SELECT key,value FROM bk.settings WHERE NOT (${mine}) AND key NOT LIKE 'migr\\_%' ESCAPE '\\'`);
              continue;
            }
            db.exec(`DELETE FROM main.${q(t)}`);
            if (!theirs.has(t)) continue; // una copia vieja no tiene las tablas de funciones nuevas
            const bk = new Set(db.prepare(`PRAGMA bk.table_info(${q(t)})`).all().map((c) => c.name));
            const cols = db.prepare(`PRAGMA main.table_info(${q(t)})`).all().map((c) => c.name).filter((c) => bk.has(c)).map(q).join(',');
            if (cols) db.exec(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM bk.${q(t)}`);
          }
          db.exec('DELETE FROM main.user_sessions');
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ya cerrada */ } throw e; }
      } finally { db.exec('DETACH DATABASE bk'); }
    } catch (e) {
      throw new Error(`No se restauró nada (tus datos siguen como estaban): ${e.message}`);
    } finally { try { unlinkSync(tmp); } catch { /* nada */ } }
    migrateRoles(db); // los permisos de funciones nuevas para roles de una copia vieja
    set('backup_last_restore', new Date().toLocaleString('sv-SE'));
    return { restored: preview, now: dataSummary(db), safety_file: safety };
  }
  function restoreLocal(name) {
    const dir = dirOf();
    if (!(FILE_RE.test(name) || SAFETY_RE.test(name)) || !dir || !existsSync(join(dir, name))) throw new Error('No se encontró esa copia en la carpeta');
    return restoreFromFile(join(dir, name));
  }

  return { run, tryRun, activityStatus, status, configure, start, dirOf, check, keepCount, restoreFromFile, restoreLocal, validateBackup };
}
