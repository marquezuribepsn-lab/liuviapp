# Liuvi · Sistema de ventas para local de ropa

Sin dependencias: solo **Node.js 22.13+** (usa SQLite integrado). Los datos quedan en `data/liuvi.db`.

**En Windows**: hacé doble clic en `iniciar.bat`. Revisa que Node.js esté instalado, inicia el sistema y abre el navegador. No cierres esa ventana mientras vendés; para apagarlo, cerrala.
Para que arranque solo al prender la PC: botón derecho sobre `iniciar.bat` → *Crear acceso directo*, presioná `Win + R`, escribí `shell:startup` y pegá el acceso directo en esa carpeta.

```bash
npm start        # http://localhost:3000   (PORT=8080 npm start para cambiar el puerto)
npm test
```

## Funciones

- **Artículos**: cada fila es un SKU (artículo + talle + color) con código de barras, precio, costo, stock y stock mínimo. Baja lógica para conservar el historial.
- **Stock**: ingresos de mercadería, devoluciones y ajustes (con historial de movimientos), valor del inventario y alertas de stock bajo. Las ventas descuentan stock y las anulaciones lo devuelven.
- **Caja**: apertura con fondo inicial, ingresos y egresos manuales, cierre con efectivo contado y diferencia contra lo esperado, historial de cajas. No se puede vender con la caja cerrada.
- **Ventas**: pago en efectivo, tarjeta o transferencia (se puede combinar), descuento %, vuelto y anulación.
- **Estadísticas**: ventas, unidades, ticket promedio y ganancia por **día, semana, mes y año**; desglose por medio de pago y artículos más vendidos.
- **Lector de código de barras**: cualquier lector USB/Bluetooth que funcione como teclado. En *Vender* la pantalla siempre escucha el escáner; también sirve en *Artículos* y *Stock*. Si un artículo no tiene código, el botón *Generar* crea uno interno (EAN-13, prefijo 200) para imprimir como etiqueta.
- **Impresión de tickets y etiquetas** (sin drivers especiales, usa el cuadro de impresión del navegador). Viene configurada para una **impresora común en hoja A4** (también hay Carta, y térmicas de 58/80 mm):
  - *Ticket*: nombre del local, detalle, descuento, medios de pago y vuelto. En impresora común sale arriba de la hoja con ancho de ticket. Se imprime solo al cobrar (opción en *Vender*), con *Último ticket*, o desde *Caja → Ventas de hoy*.
  - *Etiquetas* con nombre, talle, color, precio y código de barras. En hoja se acomodan en grilla con borde punteado para recortar; el programa calcula cuántas entran según tamaño y margen, y se puede **saltear etiquetas** para reutilizar una hoja ya usada. También hay modo rollo (una por página). Se arman en la pestaña *Etiquetas* o con el botón *Etiqueta* de cada artículo; las copias pueden igualar el stock.
  - Los códigos se dibujan como EAN-13 (si son 13 dígitos válidos, como los que genera el botón *Generar*) o Code 128, y se verificaron con un decodificador independiente sobre el PDF impreso.
  - En el cuadro de impresión: escala 100 % («Tamaño real»), sin «Encabezados y pie de página».
  - Los ajustes se guardan en el navegador de cada PC.

- **Usuarios, contraseñas y roles**:
  - La primera vez que se abre el sistema pide crear la cuenta del administrador. No hay usuario ni contraseña por defecto.
  - Los administradores crean usuarios, desactivan cuentas y restablecen contraseñas desde la pestaña *Usuarios*.
  - Hay dos roles de fábrica: *Administrador* (todos los permisos, protegido) y *Vendedor* (vender, ver artículos y ver stock). Los administradores pueden **editar los permisos de cualquier rol (salvo el de Administrador) y crear roles nuevos**; el cambio rige al instante, incluso con la sesión ya abierta.
  - Permisos: vender, anular ventas, ver/editar artículos, ver costos y ganancias, ver/ajustar stock, ver/operar caja, ver estadísticas y administrar usuarios. Quien no tiene «ver costos» no recibe el costo ni la ganancia desde el servidor, no solo se oculta en pantalla.
  - Cada venta, movimiento de caja y de stock queda a nombre de quien lo hizo; se ve en Caja, Stock, tickets y en las estadísticas por vendedor.
  - Seguridad: contraseñas con scrypt y sal, sesiones de 12 horas en cookie HttpOnly/SameSite=Strict, bloqueo de 60 s tras 5 intentos fallidos, mínimo de 8 caracteres, y siempre queda al menos un administrador activo.

- **Una sola computadora**: el servidor acepta conexiones solo de esa misma PC (`127.0.0.1`). La base de datos es el archivo `data/liuvi.db`, dentro de la carpeta del programa (no cambia según desde dónde lo abras).
- **Copia de seguridad en Google Drive**: instalá *Google Drive para escritorio*, creá una carpeta dentro de «Mi unidad» y pegá su ruta en la pestaña *Copias*. El sistema guarda ahí una copia por día y otra al cerrar la caja; Google Drive las sube solo. Se verifica cada copia, se conservan las últimas 30 y hay un botón «Hacer copia ahora». Requiere el permiso *Configurar y hacer copias de seguridad* (los administradores lo tienen).
- **Restaurar una copia**: cerrá el sistema y ejecutá `npm run restore -- "ruta\de\la\copia.db"`. Valida el archivo y guarda la base actual al lado (`...antes-de-restaurar...`), así no se pierde nada.

## Notas

- Las semanas siguen `%W` de SQLite (lunes como primer día).
- Las copias incluyen las contraseñas cifradas de los usuarios: activá la verificación en dos pasos en la cuenta de Google.
- Si algún día necesitás usarlo desde otras PC del local: `HOST=0.0.0.0 npm start` (en Windows: `set HOST=0.0.0.0` y luego `npm start`) y entrar por `http://IP-DE-LA-PC:3000`. Ahí conviene una red de confianza, porque no hay HTTPS.
- Quien tenga el permiso *Administrar usuarios y roles* puede darse a sí mismo cualquier permiso: dáselo solo a quien sea de confianza.
