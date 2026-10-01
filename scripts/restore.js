// Uso: npm run restore -- "C:\ruta\liuvi-backup-2026-10-01_18-00-00.db"
// Cerrá el sistema antes de restaurar. La base actual se guarda aparte, no se pierde.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultDbPath } from '../db.js';

const src = process.argv[2] && resolve(process.argv[2]);
const target = process.env.DB_PATH || defaultDbPath();
const fail = (m) => { console.error('Error: ' + m); process.exit(1); };

if (!src) fail('Indicá el archivo de copia. Ejemplo: npm run restore -- "C:\\ruta\\liuvi-backup-2026-10-01_18-00-00.db"');
if (!existsSync(src)) fail('No existe el archivo: ' + src);
try {
  const db = new DatabaseSync(src, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  const ok = db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  db.close();
  if (!ok) fail('La copia está dañada (no pasó la verificación).');
  for (const t of ['articles', 'sales', 'cash_sessions', 'users']) if (!tables.includes(t)) fail(`El archivo no parece una copia de Liuvi (falta la tabla ${t}).`);
} catch (e) { fail('No se pudo abrir la copia: ' + e.message); }

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) {
  const aside = target.replace(/\.db$/, '') + `.antes-de-restaurar-${new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-')}.db`;
  copyFileSync(target, aside);
  console.log('Base actual guardada en: ' + aside);
}
for (const ext of ['-wal', '-shm']) rmSync(target + ext, { force: true });
copyFileSync(src, target);
console.log('Listo. Base restaurada en: ' + target + '\nYa podés abrir el sistema.');
