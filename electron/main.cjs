'use strict';
// Liu Vi como aplicación de escritorio: una ventana propia (Electron) que muestra el sistema.
// El sistema (server.js) corre aparte con su propio Node: acá solo se arranca, se espera a que responda y se muestra.
const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const URL_BASE = `http://localhost:${PORT}`;
// Instalado: <carpeta>\shell\LiuVi.exe y el programa en <carpeta>. En desarrollo se indica con LIUVI_APP_DIR.
const APP_DIR = process.env.LIUVI_APP_DIR || path.resolve(path.dirname(process.execPath), '..');
const DATA_DIR = process.env.LIUVI_DATA_DIR
  || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LiuVi')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'LiuVi')
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'liuvi'));
const LOG = path.join(DATA_DIR, 'liuvi.log');
const NODE_EXE = process.env.LIUVI_NODE || (fs.existsSync(path.join(APP_DIR, 'runtime', 'node.exe')) ? path.join(APP_DIR, 'runtime', 'node.exe') : 'node');
const ICON = [path.join(APP_DIR, 'liuvi.ico'), path.join(APP_DIR, 'public', 'img', 'favicon.png')].find((f) => fs.existsSync(f));

const log = (m) => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG, `[ventana ${new Date().toISOString()}] ${m}\n`); } catch { /* sin registro */ } };
process.on('uncaughtException', (e) => log('error: ' + (e?.stack || e)));
process.on('unhandledRejection', (e) => log('promesa rechazada: ' + (e?.stack || e)));

app.setName('Liu Vi');
app.setAppUserModelId('com.liuvi.app'); // agrupa la ventana con el acceso directo en la barra de tareas
if (process.platform === 'win32') { // nombre e ícono que Windows muestra en la barra de tareas (en vez de «Electron»)
  const key = 'HKCU\\Software\\Classes\\AppUserModelId\\com.liuvi.app';
  try {
    spawnSync('reg', ['add', key, '/v', 'DisplayName', '/d', 'Liu Vi', '/f'], { windowsHide: true });
    if (ICON) spawnSync('reg', ['add', key, '/v', 'IconUri', '/d', ICON, '/f'], { windowsHide: true });
  } catch { /* sin permiso: queda el nombre del ejecutable */ }
}
app.setPath('userData', path.join(DATA_DIR, 'ventana'));
app.disableHardwareAcceleration(); // evita pantallas en blanco en computadoras viejas; la interfaz es liviana
app.commandLine.appendSwitch('lang', 'es-419');

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let win = null, quitting = false;

  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

  const request = (method, p, timeout = 1500) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(method === 'POST' ? '{}' : undefined);
  });
  const alive = async () => {
    const r = await request('GET', '/api/auth/me');
    try { return !!r && r.status === 200 && typeof JSON.parse(r.data).setupNeeded === 'boolean'; } catch { return false; }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let child = null, childExited = false;
  function startServer() {
    // Si quedó un proceso viejo trabado, se lo cierra para empezar limpio.
    const pidFile = path.join(DATA_DIR, 'liuvi.pid');
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (pid > 0 && process.platform === 'win32') spawnSync('taskkill', ['/F', '/PID', String(pid), '/FI', 'IMAGENAME eq node.exe'], { windowsHide: true });
      fs.rmSync(pidFile, { force: true });
    } catch { /* no había */ }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(LOG, 'a');
    childExited = false;
    child = spawn(NODE_EXE, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      cwd: APP_DIR, detached: true, windowsHide: true, stdio: ['ignore', out, out],
      env: { ...process.env, LIUVI_SILENT: '1', LIUVI_UPDATE: '1', LIUVI_AUTOEXIT: '1', LIUVI_OPEN: '0', LIUVI_LOGFILE: LOG },
    });
    child.on('exit', () => { childExited = true; });
    child.on('error', (e) => { childExited = true; log('no se pudo iniciar el sistema: ' + e.message); });
    child.unref();
  }
  async function ensureServer() {
    if (await alive()) return true;
    startServer();
    for (let i = 0; i < 100; i++) {
      await wait(300);
      if (await alive()) return true;
      if (childExited && i > 3 && !(await alive())) return false; // se cerró solo: puerto ocupado por otro programa, etc.
    }
    return false;
  }

  const isLocal = (u) => {
    if (u === 'about:blank') return true;
    try { const x = new URL(u); return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname) && Number(x.port || 80) === PORT; } catch { return false; }
  };
  const openExternal = (u) => { try { if (/^https?:$/.test(new URL(u).protocol)) shell.openExternal(u); } catch { /* inválida */ } };

  const SPLASH = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0e1514;color:#cfe;font:20px system-ui,sans-serif"><div style="text-align:center"><div style="font-size:42px;font-weight:700;color:#2dd4bf;margin-bottom:8px">Liu Vi</div>Iniciando…</div>`);
  const FAILED = (msg) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0e1514;color:#cfe;font:18px system-ui,sans-serif"><div style="max-width:560px;text-align:center"><div style="font-size:30px;font-weight:700;color:#f87171;margin-bottom:10px">No se pudo iniciar Liu Vi</div><p>${msg}</p><p style="color:#8aa">Registro: ${LOG.replace(/\\/g, '\\\\')}</p><p style="color:#8aa">Cerrá esta ventana y volvé a abrir Liu Vi.</p></div>`);

  function buildMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Liu Vi', submenu: [{ role: 'quit', label: 'Cerrar Liu Vi' }] },
      { label: 'Edición', submenu: [{ role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' }, { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }] },
      { label: 'Ver', submenu: [{ role: 'reload', label: 'Recargar' }, { role: 'forceReload', label: 'Recargar completo' }, { type: 'separator' }, { role: 'resetZoom', label: 'Tamaño normal' }, { role: 'zoomIn', label: 'Agrandar' }, { role: 'zoomOut', label: 'Achicar' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Pantalla completa' }] },
    ]));
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1366, height: 820, minWidth: 1000, minHeight: 620, title: 'Liu Vi', icon: ICON, show: false,
      backgroundColor: '#0e1514', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => { win.maximize(); win.show(); });
    win.on('closed', () => { win = null; quit(); });
    // La página web puede abrir ventanas propias del sistema (comprobantes, etiquetas); todo lo demás va al navegador de siempre.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isLocal(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, backgroundColor: '#ffffff' } };
      openExternal(url); return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('data:') && !isLocal(url)) { e.preventDefault(); openExternal(url); } });
    win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
      if (!isMain || code === -3 || quitting || url.startsWith('data:')) return; // -3: carga cancelada por otra
      log(`no cargó ${url} (${code}); reintenta`);
      setTimeout(async () => { if (win && !quitting) { await ensureServer(); if (win) win.loadURL(URL_BASE); } }, 2000);
    });
    win.webContents.on('render-process-gone', (_e, d) => { log('la ventana se cerró sola: ' + d.reason); if (win && !quitting) win.reload(); });
    win.webContents.on('context-menu', (_e, p) => { // clic derecho: copiar / pegar en los campos de texto
      const items = [];
      if (p.isEditable) items.push({ role: 'cut', label: 'Cortar', enabled: p.editFlags.canCut }, { role: 'copy', label: 'Copiar', enabled: p.editFlags.canCopy }, { role: 'paste', label: 'Pegar', enabled: p.editFlags.canPaste }, { role: 'selectAll', label: 'Seleccionar todo' });
      else if (p.selectionText) items.push({ role: 'copy', label: 'Copiar' });
      if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
    });
    win.loadURL(SPLASH);
  }

  function quit() {
    if (quitting) return;
    quitting = true;
    // Avisa al sistema que la ventana se cerró: hace una última copia de seguridad y se apaga solo.
    Promise.race([request('POST', '/api/window/bye', 1000), wait(1200)]).finally(() => app.exit(0));
  }

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    buildMenu();
    createWindow();
    const ok = await ensureServer();
    if (!win) return;
    if (!ok) {
      log('el sistema no respondió');
      win.loadURL(FAILED('El sistema no arrancó. Si tenés otro programa usando el puerto ' + PORT + ', cerralo y probá de nuevo.'));
      return;
    }
    win.loadURL(URL_BASE);
    // Vigilancia: si el sistema se cae (o se reinicia por una actualización), se lo vuelve a levantar.
    let fails = 0;
    setInterval(async () => {
      if (quitting) return;
      if (await alive()) { fails = 0; return; }
      if (++fails >= 4) { fails = 0; log('el sistema dejó de responder; se reinicia'); await ensureServer(); }
    }, 5000).unref?.();
  });

  app.on('window-all-closed', () => quit());
  dialogGuard();
  function dialogGuard() { dialog.showErrorBox = (t, c) => log(`${t}: ${c}`); } // nunca mostrar cuadros de error técnicos
}
