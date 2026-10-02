import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, readdirSync, unlinkSync, accessSync, mkdirSync, constants } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { computerName } from './gdrive.js';

const KEEP = 30;                       // copias que se conservan en la carpeta
const FILE_RE = /^liuvi-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/;
const DAY_MS = 24 * 3600_000;

const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');

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

  const files = (dir) => (dir && existsSync(dir) ? readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().reverse() : []);

  function prune(dir) {
    for (const f of files(dir).slice(KEEP)) { try { unlinkSync(join(dir, f)); } catch { /* en uso: se borra en la próxima */ } }
  }

  // Copia consistente aun con el sistema en uso; se verifica antes de darla por buena.
  function run(reason = 'manual') {
    const dir = dirOf();
    if (!dir) throw new Error('Primero elegí la carpeta de copias');
    ensureDir(dir);
    checkDir(dir);
    const file = join(dir, `liuvi-backup-${stamp()}.db`);
    try {
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
    } catch (e) {
      try { unlinkSync(file); } catch { /* no se llegó a crear */ }
      set('backup_error', `${new Date().toLocaleString('sv-SE')} · ${e.message}`);
      throw e;
    }
    set('backup_last_at', new Date().toLocaleString('sv-SE'));
    set('backup_last_file', file);
    set('backup_last_reason', reason);
    set('backup_error', '');
    prune(dir);
    gdrive?.enqueue(file);
    return file;
  }

  // Para disparos automáticos: nunca debe romper lo que está haciendo el usuario.
  function tryRun(reason) {
    if (!dirOf() || get('backup_auto', '1') !== '1') return null;
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
    };
  }

  function configure({ dir, auto, pc_name }) {
    const d = String(dir ?? '').trim();
    if (d) checkDir(d);
    set('backup_dir', d);
    if (pc_name !== undefined) {
      const n = String(pc_name).trim().replace(/[\\/:*?"<>|']/g, '').slice(0, 60);
      set('backup_pc_name', n === computerName() ? '' : n);
    }
    set('backup_auto', auto === false ? '0' : '1');
  }

  // Copia diaria: al iniciar y luego revisando cada hora si pasaron 24 h desde la última.
  function start() {
    const due = () => { const last = get('backup_last_at'); return !last || Date.now() - new Date(last.replace(' ', 'T')).getTime() >= DAY_MS; };
    const tick = () => { if (due()) tryRun('diaria'); };
    setTimeout(tick, 5000).unref();
    setInterval(tick, 3600_000).unref();
  }

  return { run, tryRun, status, configure, start, dirOf };
}
