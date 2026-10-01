import { createServer } from 'node:http';
import { openDb, defaultDbPath, migrateLegacyDb, dataSummary, appVersion, looksTemporary, clearSessionsIfRequired } from './db.js';
import { openBrowser, probeInstance, portBusyMessage } from './launch.js';
import { createApp } from './app.js';

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
const app = createApp(db);
app.backups.start();
const server = createServer(app);
server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') console.error(portBusyMessage(port, appVersion(), await probeInstance(port)));
  else console.error('No se pudo iniciar:', e.message);
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
  if (process.env.LIUVI_OPEN === '1') openBrowser(`http://localhost:${port}`);
  if (looksTemporary()) console.log('\nATENCIÓN: el programa está en una carpeta temporal o dentro de un ZIP.\nExtraé el ZIP completo (clic derecho > Extraer todo) en una carpeta fija, por ejemplo Documentos, y abrí iniciar.bat desde ahí.');
  if (host !== '127.0.0.1' && host !== 'localhost') console.log(`Atención: accesible desde la red (${host}).`);
});
