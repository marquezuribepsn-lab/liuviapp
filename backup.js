import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, readdirSync, unlinkSync, accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const KEEP = 30;                       // copias que se conservan en la carpeta
const FILE_RE = /^liuvi-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/;
const DAY_MS = 24 * 3600_000;

const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');

export function createBackups(db) {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const get = (k, d = '') => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
  const set = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

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
    const dir = get('backup_dir');
    if (!dir) throw new Error('Primero elegí la carpeta de copias');
    checkDir(dir);
    const file = join(dir, `liuvi-backup-${stamp()}.db`);
    try {
      db.prepare('VACUUM INTO ?').run(file);
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
    return file;
  }

  // Para disparos automáticos: nunca debe romper lo que está haciendo el usuario.
  function tryRun(reason) {
    if (!get('backup_dir') || get('backup_auto', '1') !== '1') return null;
    try { return run(reason); } catch (e) { console.error('Copia de seguridad fallida:', e.message); return null; }
  }

  function status() {
    const dir = get('backup_dir');
    return {
      dir, auto: get('backup_auto', '1') === '1',
      last_at: get('backup_last_at') || null, last_file: get('backup_last_file') || null,
      last_reason: get('backup_last_reason') || null, error: get('backup_error') || null,
      files: files(dir).slice(0, 10).map((name) => { const st = statSync(join(dir, name)); return { name, size: st.size, at: st.mtime.toLocaleString('sv-SE') }; }),
    };
  }

  function configure({ dir, auto }) {
    const d = String(dir ?? '').trim();
    if (d) checkDir(d);
    set('backup_dir', d);
    set('backup_auto', auto === false ? '0' : '1');
  }

  // Copia diaria: al iniciar y luego revisando cada hora si pasaron 24 h desde la última.
  function start() {
    const due = () => { const last = get('backup_last_at'); return !last || Date.now() - new Date(last.replace(' ', 'T')).getTime() >= DAY_MS; };
    const tick = () => { if (due()) tryRun('diaria'); };
    setTimeout(tick, 5000).unref();
    setInterval(tick, 3600_000).unref();
  }

  return { run, tryRun, status, configure, start };
}
