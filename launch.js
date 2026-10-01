// Apertura del navegador y detección de otra copia del programa ya abierta.
import { spawn } from 'node:child_process';

// Comando para abrir una dirección en el navegador predeterminado de cada sistema.
export function browserCommand(platform, url) {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  try {
    const [cmd, args] = browserCommand(platform, url);
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
