import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

// Catálogo de permisos. Los administradores configuran qué permisos tiene cada rol.
export const PERMISSIONS = [
  { key: 'ventas.cobrar', label: 'Vender y cobrar', group: 'Ventas' },
  { key: 'ventas.anular', label: 'Anular ventas', group: 'Ventas' },
  { key: 'ventas.devolver', label: 'Hacer cambios y devoluciones', group: 'Ventas' },
  { key: 'clientes.ver', label: 'Ver clientes, su historial y su cuenta corriente', group: 'Clientes' },
  { key: 'clientes.editar', label: 'Crear y editar clientes', group: 'Clientes' },
  { key: 'clientes.cuenta', label: 'Cargar saldo o señas y cobrar deudas de clientes', group: 'Clientes' },
  { key: 'clientes.fiar', label: 'Vender a cuenta (dejar al cliente debiendo)', group: 'Clientes' },
  { key: 'articulos.ver', label: 'Ver artículos', group: 'Artículos' },
  { key: 'articulos.editar', label: 'Crear, editar y dar de baja artículos', group: 'Artículos' },
  { key: 'costos.ver', label: 'Ver costos y ganancias', group: 'Artículos' },
  { key: 'stock.ver', label: 'Ver stock y movimientos', group: 'Stock' },
  { key: 'stock.ajustar', label: 'Ingresar mercadería y ajustar stock', group: 'Stock' },
  { key: 'stock.limpiar', label: 'Limpiar todo el stock (dejarlo en 0 o borrar todos los artículos)', group: 'Stock' },
  { key: 'caja.ver', label: 'Ver caja, movimientos e historial', group: 'Caja' },
  { key: 'caja.operar', label: 'Abrir y cerrar caja, registrar ingresos y egresos', group: 'Caja' },
  { key: 'estadisticas.ver', label: 'Ver estadísticas', group: 'Estadísticas' },
  { key: 'usuarios.admin', label: 'Administrar usuarios y roles', group: 'Administración' },
  { key: 'sistema.copias', label: 'Configurar y hacer copias de seguridad', group: 'Administración' },
];
export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key);

export const DEFAULT_ROLES = [
  { name: 'Administrador', is_admin: 1, permissions: ALL_PERMISSIONS },
  { name: 'Vendedor', is_admin: 0, permissions: ['ventas.cobrar', 'ventas.devolver', 'clientes.ver', 'clientes.editar', 'clientes.cuenta', 'articulos.ver', 'stock.ver'] },
];

export const MIN_PASSWORD = 8;
export const SESSION_HOURS = 12;

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

const DUMMY = hashPassword('dummy-password-for-timing');

// Compara en tiempo constante; si no hay hash (usuario inexistente) igual gasta el mismo tiempo.
export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = (stored || DUMMY).split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected) && Boolean(stored);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(t).digest('hex');

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split(/=(.*)/s)).filter((p) => p[0]).map((p) => [p[0], p[1] ?? '']));
}

// Intentos fallidos por usuario+IP: 5 errores bloquean 60 s; si se sigue fallando el bloqueo crece
// (60 s, 5 min, 25 min, tope 30 min), para que un PIN corto no se pueda adivinar probando.
export function createLimiter({ max = 5, lockMs = 60_000, maxLockMs = 30 * 60_000, now = Date.now } = {}) {
  const m = new Map();
  return {
    check(key) { const e = m.get(key); return e && e.until > now() ? Math.ceil((e.until - now()) / 1000) : 0; },
    fail(key) {
      const e = m.get(key) || { n: 0, until: 0, level: 0 };
      if (e.until && e.until <= now()) { e.until = 0; e.n = 0; } // venció el bloqueo: se cuenta de nuevo (el nivel de castigo se conserva)
      e.n++;
      if (e.n >= max) { e.until = now() + Math.min(maxLockMs, lockMs * 5 ** e.level); e.level++; e.n = 0; }
      m.set(key, e);
    },
    ok(key) { m.delete(key); },
  };
}

// PIN de acceso rápido: 4 a 8 números. Solo vale desde la propia computadora (como el PIN de Windows).
export const PIN_RE = /^\d{4,8}$/;
export function isWeakPin(pin) {
  const d = [...pin].map(Number);
  const step = (k) => d.every((x, i) => i === 0 || x - d[i - 1] === k);
  return step(0) || step(1) || step(-1); // 0000, 1234, 4321
}
export const isLoopback = (addr = '') => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
