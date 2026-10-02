import { createServer } from 'node:http';
import { writeFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb, defaultDbPath, migrateLegacyDb, dataSummary, appVersion, looksTemporary, clearSessionsIfRequired } from './db.js';
import { openBrowser, probeInstance, portBusyMessage } from './launch.js';
import { createApp } from './app.js';
import { relaunchServer } from './updater.js';
import { APP_DIR } from './db.js';

// Una falla inesperada en un pedido o en una tarea de fondo se registra, pero no cierra el sistema en medio de una venta.
process.on('uncaughtException', (e) => console.error('Error inesperado (el sistema sigue funcionando):', e));
process.on('unhandledRejection', (e) => console.error('Error inesperado en una tarea (el sistema sigue funcionando):', e));
const port = Number(process.env.PORT) || 3000;
// Una sola computadora: por defecto solo acepta conexiones de esta misma PC.
// Para abrirlo a la red del local: HOST=0.0.0.0 npm start
const host = process.env.HOST || '127.0.0.1';
if (!process.env.DB_PATH) {
  const m = migrateLegacyDb();
  if (m.migrated) console.log(`Se trasladó tu base de datos anterior:\n  de ${m.from}\n  a ${m.to}\n(la original queda como respaldo)`);
}
const db = openDb();
clearSessionsIfRequired(db); // al abrir el programa hay que iniciar sesión (configurable por el administrador)
let server;
const app = createApp(db, { restart: () => relaunchServer({ appDir: APP_DIR, closeServer: () => server.close() }) });
app.backups.start();
app.updater.start();
server = createServer(app);
server.keepAliveTimeout = 65_000; // evita cortar conexiones que el navegador reutiliza
server.requestTimeout = 5 * 60_000; // importaciones y restauraciones grandes pueden tardar
const silent = process.env.LIUVI_SILENT === '1'; // abierto desde el instalador: sin ventana negra
const appWindow = process.env.LIUVI_APP_WINDOW === '1';
const url = `http://localhost:${port}`;
server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    const other = await probeInstance(port);
    console.error(portBusyMessage(port, appVersion(), other));
    if (silent && other) openBrowser(url, { appWindow }); // ya estaba abierto: el acceso directo solo trae la ventana
    if (silent && other) await new Promise((r) => setTimeout(r, 1500)); // deja que el sistema lance la ventana antes de salir
  } else console.error('No se pudo iniciar:', e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  const s = dataSummary(db);
  console.log(`Liu Vi v${appVersion()} listo en http://localhost:${port}`);
  console.log(`Base de datos: ${defaultDbPath()}`);
  console.log(s.users + s.articles + s.sales === 0
    ? 'Datos guardados: ninguno todavía (base nueva)'
    : `Datos guardados: ${s.users} usuario(s), ${s.articles} artículo(s), ${s.sales} venta(s)`);
  // El navegador se abre recién ahora (con el sistema ya funcionando): si el puerto estaba ocupado, no se abre nada.
  if (process.env.LIUVI_OPEN === '1') openBrowser(url, { appWindow });
  // Para «Detener Liu Vi» y para el instalador: quién es el proceso en marcha.
  const pidFile = join(dirname(defaultDbPath()), 'liuvi.pid');
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0)); // salir limpio (borra el archivo de arriba)
  try { writeFileSync(pidFile, String(process.pid)); process.on('exit', () => { try { rmSync(pidFile); } catch { /* ya no está */ } }); } catch { /* sin permiso: solo se pierde el atajo de detener */ }
  const logFile = process.env.LIUVI_LOGFILE; // el registro no crece sin límite
  if (logFile) { try { if (statSync(logFile).size > 2_000_000) truncateSync(logFile, 0); } catch { /* sin registro */ } }
  if (looksTemporary()) console.log('\nATENCIÓN: el programa está en una carpeta temporal o dentro de un ZIP.\nExtraé el ZIP completo (clic derecho > Extraer todo) en una carpeta fija, por ejemplo Documentos, y abrí iniciar.bat desde ahí.');
  if (host !== '127.0.0.1' && host !== 'localhost') console.log(`Atención: accesible desde la red (${host}).`);
});
