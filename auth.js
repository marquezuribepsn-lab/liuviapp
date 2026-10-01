import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

// Catálogo de permisos. Los administradores configuran qué permisos tiene cada rol.
export const PERMISSIONS = [
  { key: 'ventas.cobrar', label: 'Vender y cobrar', group: 'Ventas' },
  { key: 'ventas.anular', label: 'Anular ventas', group: 'Ventas' },
  { key: 'articulos.ver', label: 'Ver artículos', group: 'Artículos' },
  { key: 'articulos.editar', label: 'Crear, editar y dar de baja artículos', group: 'Artículos' },
  { key: 'costos.ver', label: 'Ver costos y ganancias', group: 'Artículos' },
  { key: 'stock.ver', label: 'Ver stock y movimientos', group: 'Stock' },
  { key: 'stock.ajustar', label: 'Ingresar mercadería y ajustar stock', group: 'Stock' },
  { key: 'caja.ver', label: 'Ver caja, movimientos e historial', group: 'Caja' },
  { key: 'caja.operar', label: 'Abrir y cerrar caja, registrar ingresos y egresos', group: 'Caja' },
  { key: 'estadisticas.ver', label: 'Ver estadísticas', group: 'Estadísticas' },
  { key: 'usuarios.admin', label: 'Administrar usuarios y roles', group: 'Administración' },
  { key: 'sistema.copias', label: 'Configurar y hacer copias de seguridad', group: 'Administración' },
];
export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key);

export const DEFAULT_ROLES = [
  { name: 'Administrador', is_admin: 1, permissions: ALL_PERMISSIONS },
  { name: 'Vendedor', is_admin: 0, permissions: ['ventas.cobrar', 'articulos.ver', 'stock.ver'] },
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

// Intentos fallidos por usuario+IP: 5 errores bloquean 60 s.
export function createLimiter({ max = 5, lockMs = 60_000 } = {}) {
  const m = new Map();
  return {
    check(key) { const e = m.get(key); return e && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 1000) : 0; },
    fail(key) {
      const e = m.get(key) || { n: 0, until: 0 };
      e.n = e.until && e.until <= Date.now() ? 1 : e.n + 1;
      if (e.n >= max) { e.until = Date.now() + lockMs; e.n = 0; }
      m.set(key, e);
    },
    ok(key) { m.delete(key); },
  };
}
