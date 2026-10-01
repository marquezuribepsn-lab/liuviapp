import { createServer } from 'node:http';
import { openDb, defaultDbPath } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
// Una sola computadora: por defecto solo acepta conexiones de esta misma PC.
// Para abrirlo a la red del local: HOST=0.0.0.0 npm start
const host = process.env.HOST || '127.0.0.1';
const app = createApp(openDb());
app.backups.start();
const server = createServer(app);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`El sistema ya esta abierto (el puerto ${port} esta en uso). Usa la ventana o pestana que ya tenias.`);
  else console.error('No se pudo iniciar:', e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`Liuvi listo en http://localhost:${port}`);
  console.log(`Base de datos: ${defaultDbPath()}`);
  if (host !== '127.0.0.1' && host !== 'localhost') console.log(`Atención: accesible desde la red (${host}).`);
});
