# Liu Vi · Sistema de ventas para local de ropa

Ventas, caja, stock, clientes, proveedores, ofertas, reportes y copias de seguridad en un solo programa, pensado para un local (marcas Koxis, Adicta e Inversa). Funciona **sin internet** (internet solo se usa para las copias en Google Drive y para buscar actualizaciones) y no tiene dependencias: solo **Node.js 22.13+** (usa SQLite integrado).

## Instalación

**Windows (recomendado)**: `Liu-Vi-Setup-<versión>.exe`. Es un asistente clásico (Siguiente, Siguiente…) que incluye todo lo necesario —no hace falta instalar Node.js— y crea los accesos directos «Liu Vi» (escritorio y menú Inicio). Liu Vi se abre en su propia ventana, sin ventana negra; al cerrar la ventana el programa se cierra solo (hace una última copia de seguridad si están activadas). «Cerrar Liu Vi» del menú Inicio lo cierra a la fuerza. Instalar encima de una versión anterior la actualiza y conserva todos los datos. Como el instalador no está firmado digitalmente, Windows puede mostrar un aviso de SmartScreen: *Más información → Ejecutar de todas formas*. Para generar el instalador: `installer/build.sh` (necesita `makensis`; ver el encabezado del script).

**Windows, sin instalar**: doble clic en `iniciar.bat` (revisa que Node.js esté instalado, inicia el sistema y abre el navegador; no cierres esa ventana mientras vendés).

**Mac**: doble clic en `iniciar.command` (la primera vez: botón derecho → *Abrir*; si dice «permiso denegado», `chmod +x iniciar.command`). Para imprimir conviene Chrome, Edge o Firefox.

```bash
npm start        # http://localhost:3000   (PORT=8080 npm start para cambiar el puerto)
npm test
```

## Tus datos

La base de datos (usuarios, artículos, ventas, caja…) vive en una carpeta fija de tu usuario, **fuera de la carpeta del programa**, así que actualizar o reinstalar no la toca:

| Sistema | Ubicación de `liuvi.db` |
|---|---|
| Windows | `C:\Users\<usuario>\AppData\Local\LiuVi\` |
| Mac | `~/Library/Application Support/LiuVi/` |
| Linux | `~/.local/share/liuvi/` |

La ubicación se ve al iniciar y en la pestaña *Copias*. Para elegir otra carpeta: variable de entorno `LIUVI_DATA_DIR`. Desde una versión anterior que guardaba los datos dentro del programa (`data/`), se copian solos la primera vez.

## Actualizaciones

En **Copias → Actualizaciones del programa** (solo administradores, en el programa instalado) Liu Vi avisa cuando hay una versión nueva —lo revisa al abrir y cada 6 horas— y con **Actualizar ahora** la instala: hace una copia de seguridad, descarga la versión desde GitHub, la prueba aparte, reemplaza los archivos y se reinicia solo en unos segundos. No toca tus datos ni la conexión con Google; la versión anterior queda en `.update/anterior`. Si una versión pidiera un motor (Node) más nuevo, se indica que hay que usar el instalador completo.

## Funciones

- **Inicio**: resumen del día —vendido hoy contra ayer, ventas, ganancia, efectivo en caja, stock bajo, lo que te deben los clientes y lo que debés a proveedores, señas abiertas—, gráfico de 7 días, más vendidos y avisos (caja cerrada, copias sin configurar o atrasadas, versión nueva).
- **Ventas y caja**: pantalla de cobro con lector de código de barras, varios medios de pago por venta (efectivo, tarjeta, transferencia, cuenta del cliente), descuento y recargo (% o $), vuelto, ofertas automáticas, ventas en espera, cambios y devoluciones, anulaciones, ingresos y egresos manuales, cierre de caja con efectivo contado y diferencia, historial de cajas y comprobantes imprimibles. No se vende con la caja cerrada.
- **Clientes**: ficha, historial de compras y **cuenta corriente** (saldo a favor o deuda), cobro de deudas, **señas con mercadería apartada** y devolución de saldo. Vender a cuenta requiere un permiso aparte.
- **Inventario** (agrupa tres secciones):
  - **Artículos**: cada fila es un SKU (artículo + talle + color) con código de barras, precio, costo, stock y stock mínimo; marcas; importación masiva desde Excel (con vista previa y errores por fila); **cambio de precios en bloque** por marca, categoría, nombre o por artículos puntuales (%, monto fijo, redondeo) con vista previa, historial y deshacer.
  - **Stock**: ingresos y ajustes con historial, valor del inventario, alertas de stock bajo, limpieza total con doble confirmación, filtro «Solo ofertas» en el buscador y **Ofertas** (botón *+ CREAR OFERTAS* junto a las secciones de Inventario; se administran desde *Administrar ofertas*): porcentaje, precio fijo, llevá N pagá M (2x1, 3x2…) y segunda unidad con descuento, con fechas opcionales. Se aplican solas al cobrar y salen en el comprobante; un artículo está en una sola oferta activa.
  - **Proveedores**: compras que suman stock (y actualizan el costo si se quiere), deuda por proveedor, pagos desde la caja o fuera de ella, y edición o anulación de compras ya cargadas.
- **Etiquetas**: impresión de etiquetas con código de barras (EAN-13 / Code 128) en hoja o rollo.
- **Reportes y estadísticas** (agrupa dos secciones): *Estadísticas* por día, semana, mes y año, por medio de pago, marca y vendedor; *Reportes* de ventas, artículos, marcas, vendedores, cajas, stock valorizado, cuentas de clientes y compras/deudas con proveedores, con rango de fechas, impresión/PDF y descarga en **Excel**.
- **Usuarios y seguridad**: primer arranque crea al administrador (no hay usuario por defecto); roles con permisos editables; contraseñas con scrypt; PIN de acceso rápido solo desde esta PC; bloqueo de pantalla y bloqueo automático por inactividad; inicio de sesión al abrir; cada operación queda a nombre de quien la hizo; quien no tiene «ver costos» no los recibe desde el servidor.
- **Copias de seguridad**: automáticas en los horarios que elijas (varias veces por día) y al cerrar la caja, en una carpeta local y, si querés, en **tu Google Drive** (botón «Conectar con Google», ver `LEEME-GOOGLE-DRIVE.md`). Una barra «Respaldando» abajo a la izquierda avisa cuando se está haciendo una. Se pueden **restaurar** desde el programa (copia local, archivo o Google Drive) y siempre se guarda una copia previa.

### Permisos

Vender y cobrar · anular ventas · cambios y devoluciones · ver/editar clientes · cuenta corriente · vender a cuenta · ver/editar artículos · ver costos y ganancias · ver/ajustar stock · limpiar stock · ver/operar caja · ver estadísticas · ver/editar proveedores · administrar usuarios y roles · copias de seguridad. Los roles de fábrica son *Administrador* (todo) y *Vendedor*; los administradores pueden editar los demás roles o crear nuevos, y el cambio rige al instante.

## Seguridad y red

- **Una sola computadora**: por defecto el servidor solo acepta conexiones de esa PC (`127.0.0.1`) y solo atiende pedidos dirigidos a `localhost`; envía cabeceras de seguridad (CSP, anti-incrustado) y limita el tamaño de los pedidos.
- Para usarlo desde otras PC del local: `HOST=0.0.0.0 npm start` (en Windows: `set HOST=0.0.0.0` y luego `npm start`) y entrar por `http://IP-DE-LA-PC:3000`. Conviene una red de confianza: no hay HTTPS.
- Las copias incluyen las contraseñas cifradas de los usuarios: activá la verificación en dos pasos en la cuenta de Google.
- Quien tenga el permiso *Administrar usuarios y roles* puede darse a sí mismo cualquier permiso: dáselo solo a quien sea de confianza.

## Si algo no anda

- **Se ve una pantalla vieja después de actualizar**: casi siempre sigue abierta la versión anterior. La versión se ve al pie de todas las pantallas (`Liu Vi v1.x.x`); si no es la esperada, cerrá Liu Vi del todo («Cerrar Liu Vi») y abrilo de nuevo.
- **Pide crear el administrador otra vez**: está buscando los datos en un lugar donde no hay ninguno. La pantalla de primer uso muestra la ruta de la base; si el programa está dentro de un ZIP sin extraer, extraelo en una carpeta fija. Para recuperar datos de una instalación vieja: `npm run restore -- "ruta\a\la\carpeta\vieja\data\liuvi.db"`.
- **Restaurar una copia con el sistema cerrado**: `npm run restore -- "ruta\de\la\copia.db"` (valida el archivo y guarda la base actual al lado).
- **Registro de errores** (instalador de Windows): `%LOCALAPPDATA%\LiuVi\liuvi.log`.

## Para desarrolladores

- `server.js` arranca el servidor; `app.js` tiene todas las rutas y reglas de negocio; `db.js` el esquema y las migraciones (solo suman columnas y tablas); `backup.js`, `gdrive.js`, `updater.js`, `importer.js`, `reports.js`, `xlsx.js` son módulos aparte; `public/` es la pantalla (JavaScript puro, sin frameworks; `promo.js` es el cálculo de ofertas que comparten la pantalla y el servidor).
- `npm test` corre las pruebas (incluye pruebas de invariantes con operaciones al azar: stock, caja, cuentas y compras tienen que cerrar siempre).
- El tema de colores está en las variables del principio de `public/style.css`; el logo, en `public/img/`.
