import { createServer } from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const server = createServer(createApp(openDb()));
server.listen(port, () => console.log(`Liuvi listo en http://localhost:${port}`));
