# Liu Vi · Sistema de ventas para local de ropa

Sin dependencias: solo **Node.js 22.13+** (usa SQLite integrado).

**Tus datos no se pierden al actualizar.** La base de datos (usuarios, artículos, ventas, caja) vive en una carpeta fija de tu usuario, **fuera de la carpeta del programa**:

| Sistema | Ubicación del archivo `liuvi.db` |
|---|---|
| Windows | `C:\Users\<tu usuario>\AppData\Local\LiuVi\` |
| Mac | `~/Library/Application Support/LiuVi/` |
| Linux | `~/.local/share/liuvi/` |

Así podés bajar un ZIP nuevo, extraerlo donde quieras o abrir el programa desde otra carpeta, y sigue todo igual. Al iniciar, el programa muestra la ubicación de la base, y también está en la pestaña *Copias*. Para elegir otra carpeta: variable de entorno `LIUVI_DATA_DIR`. Si venís de una versión que guardaba los datos en `data/` dentro del programa, se copian solos la primera vez (la original queda como respaldo).

**Instalador para Windows** (recomendado): `Liu-Vi-Setup-<versión>.exe`. Es un asistente de instalación clásico (Siguiente, Siguiente…) que incluye todo lo necesario —no hace falta instalar Node.js— y crea los accesos directos «Liu Vi» (escritorio y menú Inicio). Liu Vi se abre en su propia ventana, sin ventana negra, y corre en segundo plano: para cerrarlo del todo usá «Cerrar Liu Vi» del menú Inicio. Instalar encima de una versión anterior la actualiza y conserva todos los datos. Para generar el instalador: `installer/build.sh` (necesita `makensis`; ver el encabezado del script).

**En Windows, sin instalar**: hacé doble clic en `iniciar.bat`. Revisa que Node.js esté instalado, inicia el sistema y abre el navegador. No cierres esa ventana mientras vendés; para apagarlo, cerrala.
Para que arranque solo al prender la PC: botón derecho sobre `iniciar.bat` → *Crear acceso directo*, presioná `Win + R`, escribí `shell:startup` y pegá el acceso directo en esa carpeta.

**En Mac**: hacé doble clic en `iniciar.command` (hace lo mismo que el `.bat`: revisa Node.js, inicia el sistema y abre el navegador). La primera vez macOS puede decir que viene de un desarrollador no identificado: botón derecho sobre el archivo → *Abrir* → *Abrir*. Si dice «permiso denegado», abrí Terminal en la carpeta y ejecutá `chmod +x iniciar.command`. Para que arranque solo: *Ajustes del Sistema → General → Ítems de inicio* y agregá `iniciar.command`.
Para imprimir tickets y etiquetas conviene usar Chrome, Edge o Firefox: Safari no respeta bien el tamaño de página que pide el sistema.

```bash
npm start        # http://localhost:3000   (PORT=8080 npm start para cambiar el puerto)
npm test
```

## Si después de actualizar se sigue viendo la pantalla vieja

Casi siempre es que **la versión anterior sigue abierta**: su ventana negra no se cerró y, al abrir la nueva, el navegador se conecta a la vieja. Cómo comprobarlo y solucionarlo:

- **Mirá la versión**: está al pie de todas las pantallas («Liu Vi v1.8.0»), en la pantalla de acceso y en la primera línea de la ventana negra. Si no es la que bajaste, estás viendo la vieja.
- Si al abrir `iniciar.bat` la ventana negra dice **«ATENCION: ya hay OTRA COPIA de Liu Vi abierta… de una version distinta»**, cerrá la ventana negra anterior (la que dice la versión vieja) y volvé a abrir `iniciar.bat`. El navegador solo se abre cuando el programa arrancó bien, así que en ese caso no se abre.
- El programa le indica al navegador que consulte siempre si hay archivos nuevos (los scripts y estilos llevan la versión en su dirección), y la página se recarga sola una vez si detecta que quedó guardada una versión anterior. Si aun así dudás, probá `Ctrl + F5`.

## Si el sistema pide crear el administrador otra vez

Significa que está buscando los datos en un lugar donde no hay ninguno. Para saber dónde busca:

- La **ventana negra** de `iniciar.bat` / `iniciar.command` muestra, al iniciar, tres líneas: la versión (`Liu Vi v1.1.0`), `Base de datos: <ruta>` y `Datos guardados: N usuario(s), N artículo(s), N venta(s)` (o «ninguno todavía» si la base es nueva).
- La **pantalla de primer uso** muestra la misma ruta y la versión. Si no aparece la versión, se está usando una versión vieja: bajá el ZIP de `main` otra vez.
- Si el programa está dentro de un ZIP sin extraer o en una carpeta temporal, la ventana negra avisa: extraé el ZIP completo en una carpeta fija (por ejemplo Documentos).
- Para recuperar datos de una instalación vieja: `npm run restore -- "ruta\a\la\carpeta\vieja\data\liuvi.db"`.

## Identidad visual

La interfaz usa el logo y la paleta de Liu Vi: verde agua `#37c2b9` (el del logo) y blanco, con tonos más oscuros del mismo verde para botones y textos (contraste mínimo 4,5:1) y modo oscuro automático. Los archivos del logo están en `public/img/`: `logo-blanco.png` (encabezado y acceso), `logo-tinta.png` (ticket, para imprimir sobre papel blanco), `favicon.png` y el original en `logo-original.png`. Los colores se cambian en un solo lugar: las variables al principio de `public/style.css`.

## Funciones

- **Artículos**: cada fila es un SKU (artículo + talle + color) con código de barras, precio, costo, stock y stock mínimo. Baja lógica para conservar el historial.
- **Marcas**: vienen cargadas *Koxis*, *Adicta* e *Inversa*. Cada artículo tiene su marca (se elige o se escribe: si no existe se crea, sin duplicar por mayúsculas), se puede filtrar y buscar por marca, y la marca sale en las etiquetas, en el ticket y en las estadísticas de ventas por marca. Las marcas se agregan, renombran y borran (solo las que no tienen artículos) desde la pestaña *Artículos*.
- **Importar artículos desde Excel** (pestaña *Artículos* → *Importar desde Excel*): carga cientos o miles de artículos de una vez, por ejemplo al instalar el programa en otra computadora. Funciona en tres pasos: (1) elegís el archivo `.xlsx` o `.csv`; (2) el programa **analiza** la planilla y muestra un resumen (filas leídas, nuevas, que ya existen, marcas que se van a crear) y las **filas con errores con su número de fila**, sin cargar nada todavía; (3) al confirmar, **carga con una barra de avance** y, al terminar, muestra el resultado y **actualiza el sistema solo**. Solo hacen falta las columnas *Artículo* y *Precio*; las demás (Código de barras, Marca, Categoría, Talle, Color, Costo, Stock, Stock mínimo) son opcionales, pueden ir en otro orden y se reconocen por su nombre (también «Talla», «Cantidad», «PVP»…). Se baja una **planilla modelo con instrucciones** desde la misma ventana. Si un artículo ya existe (mismo código de barras, o misma marca + nombre + talle + color cuando no tiene código) se elige qué hacer: dejarlo, actualizarlo con el stock de la planilla, o actualizarlo y sumar el stock; volver a cargar el mismo archivo no duplica nada. Los códigos faltantes se crean (EAN-13 interno), las marcas nuevas se crean, y el costo solo lo carga quien tiene permiso de ver costos. Límites: 20.000 filas y 25 MB por archivo. En `ejemplos/` hay una planilla con 300 artículos de prueba (100 de Koxis, 100 de Adicta y 100 de Inversa, inventados).
- **Stock**: ingresos de mercadería, devoluciones y ajustes (con historial de movimientos), valor del inventario y alertas de stock bajo. Las ventas descuentan stock y las anulaciones lo devuelven.
  - **Ingreso de mercadería**: a la izquierda se escribe o se escanea el artículo y a la derecha hay una **lista de búsqueda** que se filtra mientras se escribe (también por marca y «solo stock bajo o agotado»); un clic elige el artículo y el cursor pasa a la cantidad. Tras aplicar, la búsqueda se conserva con el stock actualizado, para cargar seguidos los demás talles del mismo modelo. «Stock bajo o agotado» y «Últimos movimientos» (al fondo, en horizontal, con motivos en español) tienen su propio scroll para que la pantalla no se haga interminable.
  - **Limpiar stock completo** (permiso propio, *Limpiar todo el stock*, que tienen los administradores): ofrece *dejar todo el stock en 0* (los artículos se conservan y cada baja queda en los movimientos) o *borrar todos los artículos* (los que nunca se vendieron se borran; los que ya tienen ventas quedan dados de baja para no perder el historial; las marcas se conservan). Pide **dos confirmaciones**: elegir y continuar, y luego escribir la palabra `LIMPIAR`. Si hay carpeta de copias configurada, antes se hace una copia de seguridad y, si falla, no se limpia nada. No se puede limpiar mientras hay una carga de Excel en curso.
- **Ventas y caja** (una sola pestaña, la primera): con la caja cerrada solo se ve el cuadro para abrirla (fondo inicial); con la caja abierta aparecen los totales de la caja, la venta (pago en efectivo, tarjeta o transferencia, combinables, con descuento %, vuelto y anulación), los ingresos y egresos manuales, el cierre con efectivo contado y diferencia contra lo esperado, las ventas de hoy y el historial de cajas. No se puede vender con la caja cerrada.
- **Estadísticas**: ventas, unidades, ticket promedio y ganancia por **día, semana, mes y año**; desglose por medio de pago y artículos más vendidos.
- **Lector de código de barras**: cualquier lector USB/Bluetooth que funcione como teclado. En *Vender* la pantalla siempre escucha el escáner; también sirve en *Artículos* y *Stock*. Si un artículo no tiene código, el botón *Generar* crea uno interno (EAN-13, prefijo 200) para imprimir como etiqueta.
- **Impresión de tickets y etiquetas** (sin drivers especiales, usa el cuadro de impresión del navegador). Viene configurada para una **impresora común en hoja A4** (también hay Carta, y térmicas de 58/80 mm):
  - *Ticket*: nombre del local, detalle, descuento, medios de pago y vuelto. En impresora común sale arriba de la hoja con ancho de ticket. Se imprime solo al cobrar (opción en *Ventas y caja*), con *Último ticket*, o desde *Ventas de hoy*, en la misma pestaña.
  - *Etiquetas* con nombre, talle, color, precio y código de barras. En hoja se acomodan en grilla con borde punteado para recortar; el programa calcula cuántas entran según tamaño y margen, y se puede **saltear etiquetas** para reutilizar una hoja ya usada. También hay modo rollo (una por página). Se arman en la pestaña *Etiquetas* o con el botón *Etiqueta* de cada artículo; las copias pueden igualar el stock.
  - Los códigos se dibujan como EAN-13 (si son 13 dígitos válidos, como los que genera el botón *Generar*) o Code 128, y se verificaron con un decodificador independiente sobre el PDF impreso.
  - En el cuadro de impresión: escala 100 % («Tamaño real»), sin «Encabezados y pie de página».
  - Los ajustes se guardan en el navegador de cada PC.

- **Usuarios, contraseñas y roles**:
  - La primera vez que se abre el sistema pide crear la cuenta del administrador. No hay usuario ni contraseña por defecto.
  - Los administradores crean usuarios, desactivan cuentas y restablecen contraseñas desde la pestaña *Usuarios*.
  - Hay dos roles de fábrica: *Administrador* (todos los permisos, protegido) y *Vendedor* (vender, ver artículos y ver stock). Los administradores pueden **editar los permisos de cualquier rol (salvo el de Administrador) y crear roles nuevos**; el cambio rige al instante, incluso con la sesión ya abierta.
  - Permisos: vender, anular ventas, ver/editar artículos, ver costos y ganancias, ver/ajustar stock, ver/operar caja, ver estadísticas y administrar usuarios. Quien no tiene «ver costos» no recibe el costo ni la ganancia desde el servidor, no solo se oculta en pantalla.
  - Cada venta, movimiento de caja y de stock queda a nombre de quien lo hizo; se ve en Ventas y caja, Stock, tickets y en las estadísticas por vendedor.
  - Seguridad: contraseñas con scrypt y sal, sesiones de hasta 12 horas en cookie HttpOnly/SameSite=Strict, bloqueo que crece (60 s, 5 min, 25 min…) tras 5 intentos fallidos al iniciar sesión o desbloquear, mínimo de 8 caracteres, y siempre queda al menos un administrador activo.
- **Inicio de sesión al abrir, PIN y bloqueo de pantalla**:
  - **Al abrir el programa hay que iniciar sesión** (con la contraseña o con el PIN). Las sesiones de la vez anterior se cierran al iniciar, y la sesión del navegador muere al cerrarlo. El administrador puede desactivarlo desde su perfil.
  - **PIN de acceso rápido** (4 a 8 números, como el PIN de Windows): cada usuario lo configura en su perfil (hay que hacer clic en su nombre, arriba a la derecha) con su contraseña actual. Se escribe en el mismo campo que la contraseña, tanto para entrar como para desbloquear. Rechaza PIN muy fáciles (`0000`, `1234`, `4321`…) y **solo funciona desde esta misma computadora**: desde otro aparato de la red se necesita la contraseña. Un administrador puede quitar el PIN de quien lo olvidó (Usuarios → Editar).
  - **Bloquear**: el botón de arriba (o «Bloquear ahora» en el perfil) tapa la pantalla pero deja la sesión y la venta en curso como estaban; se vuelve con el PIN o la contraseña, y se puede entrar con otro usuario.
  - **Bloqueo automático por inactividad** (nunca, 1, 2, 5, 10, 15, 30 o 60 minutos), configurable por el administrador desde su perfil; cuenta el mouse, el teclado y el lector de código de barras. Al reabrir la pestaña después de ese tiempo, también aparece bloqueada.
  - **Perfil y seguridad** (clic en el nombre): cambiar contraseña, poner, cambiar o quitar el PIN y, para administradores, la seguridad del programa.

- **Una sola computadora**: el servidor acepta conexiones solo de esa misma PC (`127.0.0.1`). La base de datos es el archivo `liuvi.db` de la carpeta fija de tu usuario (ver arriba), sin importar desde dónde abras el programa.
- **Copia de seguridad en Google Drive**: instalá *Google Drive para escritorio*, creá una carpeta dentro de «Mi unidad» y pegá su ruta en la pestaña *Copias*. El sistema guarda ahí una copia por día y otra al cerrar la caja; Google Drive las sube solo. Se verifica cada copia, se conservan las últimas 30 y hay un botón «Hacer copia ahora». Requiere el permiso *Configurar y hacer copias de seguridad* (los administradores lo tienen).
- **Restaurar una copia**: cerrá el sistema y ejecutá `npm run restore -- "ruta\de\la\copia.db"`. Valida el archivo y guarda la base actual al lado (`...antes-de-restaurar...`), así no se pierde nada.

## Notas

- Las semanas siguen `%W` de SQLite (lunes como primer día).
- Las copias incluyen las contraseñas cifradas de los usuarios: activá la verificación en dos pasos en la cuenta de Google.
- Si algún día necesitás usarlo desde otras PC del local: `HOST=0.0.0.0 npm start` (en Windows: `set HOST=0.0.0.0` y luego `npm start`) y entrar por `http://IP-DE-LA-PC:3000`. Ahí conviene una red de confianza, porque no hay HTTPS.
- Quien tenga el permiso *Administrar usuarios y roles* puede darse a sí mismo cualquier permiso: dáselo solo a quien sea de confianza.
