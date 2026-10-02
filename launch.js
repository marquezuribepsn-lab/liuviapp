// Apertura del navegador y detección de otra copia del programa ya abierta.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Comando para abrir una dirección en el navegador predeterminado de cada sistema.
export function browserCommand(platform, url) {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

// Ventana propia sin pestañas ni barra de direcciones (modo «aplicación» de Edge o Chrome): se siente como un programa de escritorio.
// Devuelve [exe, args] o null si no hay ninguno de los dos instalados.
export function appWindowCommand(url, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return null;
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const r of rel) for (const root of roots) {
    const exe = join(root, r.replaceAll('\\', '/'));
    if (exists(exe)) return [exe, [`--app=${url}`, '--window-size=1366,820']];
  }
  return null;
}

export function openBrowser(url, { platform = process.platform, spawnFn = spawn, appWindow = false, env = process.env, exists = existsSync } = {}) {
  try {
    const [cmd, args] = (appWindow && appWindowCommand(url, { platform, env, exists })) || browserCommand(platform, url);
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {}); // sin navegador configurado: no pasa nada, se entra a mano
    child.unref?.();
  } catch { /* idem */ }
}

// Si el puerto está ocupado: ¿es otra copia de Liu Vi? ¿de qué versión? Devuelve { version } o null.
export async function probeInstance(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    if (typeof data?.setupNeeded !== 'boolean') return null; // otro programa
    return { version: data.version || 'anterior a 1.1.0' };
  } catch { return null; }
}

export function portBusyMessage(port, mine, other) {
  if (!other) return `El puerto ${port} esta ocupado por otro programa. Cerralo, o abri Liu Vi en otro puerto (por ejemplo: set PORT=3001).`;
  if (other.version === mine) return `El sistema ya esta abierto (version ${mine}). Usa la ventana o pestana que ya tenias.`;
  return [
    `ATENCION: ya hay OTRA COPIA de Liu Vi abierta en esta computadora, de una version distinta:`,
    `  - la que esta abierta es la version ${other.version}`,
    `  - esta (la que acabas de abrir) es la version ${mine}`,
    `Por eso en el navegador seguis viendo la version vieja.`,
    `Solucion: cerra la ventana negra anterior (la que dice "Liu Vi v${other.version}") y volve a abrir iniciar.bat.`,
  ].join('\n');
}
