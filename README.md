# Liuvi · Sistema de ventas para local de ropa

Sin dependencias: solo **Node.js 22.13+** (usa SQLite integrado). Los datos quedan en `data/liuvi.db`.

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
- **Impresión de tickets y etiquetas** (sin drivers especiales, usa el cuadro de impresión del navegador):
  - *Ticket* de 58 u 80 mm con nombre del local, detalle, descuento, medios de pago y vuelto. Se imprime solo al cobrar (opción en *Vender*), con *Último ticket*, o desde *Caja → Ventas de hoy*.
  - *Etiquetas* con nombre, talle, color, precio y código de barras, para rollo (una por hoja, tamaño configurable, por defecto 50×30 mm) o para hoja A4. Se arman en la pestaña *Etiquetas* o con el botón *Etiqueta* de cada artículo; las copias pueden igualar el stock.
  - Los códigos se dibujan como EAN-13 (si son 13 dígitos válidos, como los que genera el botón *Generar*) o Code 128, y se verificaron con un decodificador independiente.
  - Al imprimir, elegí la impresora y desactivá encabezados y pie de página del navegador.

## Notas

- Las semanas siguen `%W` de SQLite (lunes como primer día).
- La app no tiene usuarios ni login: usala en una red de confianza.
