# Conectar Google Drive a Liu Vi (copias en la nube)

Se hace **una sola vez**. Después, desde la pestaña **Copias** tocás «Conectar con Google», iniciás sesión con tu cuenta y listo: cada copia (una por día y al cerrar la caja) se sube sola a tu Drive, en la carpeta **Liu Vi - Copias / nombre de la computadora**.

El sistema solo puede ver lo que él mismo sube (permiso «drive.file»): no puede leer ni borrar el resto de tu Drive.

## 1. Crear las credenciales (gratis, unos 5 minutos)

1. Entrá a <https://console.cloud.google.com> con la cuenta de Google donde querés guardar las copias.
2. Arriba, **Seleccionar proyecto → Proyecto nuevo**. Nombre: `Liu Vi`. Crear.
3. Menú **APIs y servicios → Biblioteca**, buscá **Google Drive API** y tocá **Habilitar**.
4. Menú **APIs y servicios → Pantalla de consentimiento de OAuth** (o «Google Auth Platform»):
   - Tipo de usuario: **Externo**.
   - Nombre de la aplicación: `Liu Vi`. Correo de asistencia y de contacto: el tuyo.
   - En *Permisos / Scopes* agregá `.../auth/drive.file` y `.../auth/userinfo.email`.
   - **Importante:** al final tocá **Publicar aplicación** (estado «En producción»). Si la dejás en «Prueba», Google corta la conexión a los 7 días y las copias dejan de subirse. No hace falta pasar por revisión de Google: estos permisos no son sensibles.
5. Menú **Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación de escritorio**. Nombre: `Liu Vi`. Crear.
   - Copiá el **ID de cliente** y el **Secreto de cliente**.

## 2. Cargarlas en Liu Vi (una sola vez por computadora)

1. En Google Cloud, en el ID de cliente que creaste, tocá **Descargar JSON** (el archivo `client_secret_….json`).
2. Abrí Liu Vi **en esa misma computadora** → pestaña **Copias** → **Importar archivo de Google (.json)** y elegí el archivo. (También se puede escribir el ID y el secreto a mano.)
3. Aparece el botón **«Conectar con Google»**. Tocalo: se abre una **ventana de Google** igual que cuando entrás a una aplicación con «Acceder con Google». Elegí tu cuenta y tocá **Permitir**.
4. Si Google avisa «Google no verificó esta aplicación», tocá **Configuración avanzada → Ir a Liu Vi** (es tu propia aplicación).
5. La ventana se cierra sola y la pestaña Copias muestra «Conectado como tu@gmail.com». Tocá **Hacer copia y subirla ahora** para probar y mirá tu Drive.

## Varias computadoras

- Cada computadora se conecta por separado (tocando «Conectar con Google» en esa computadora) y sube a su propia subcarpeta, con el **nombre de la computadora** que pongas en la pestaña Copias.
- Para no importar el archivo en cada computadora, el instalador puede traerlo incorporado: se arma con el archivo `google-client.json` (o `installer/google-client.json`) y, en cada PC, alcanza con tocar **Conectar con Google**. A mano, en la carpeta del programa, es un archivo `google-client.json` con este contenido:

```json
{ "client_id": "123456-abc.apps.googleusercontent.com", "client_secret": "tu-secreto" }
```

## Notas

- La conexión con Google vive solo en esa computadora y **no viaja dentro de las copias**, así que al restaurar una copia en otra PC hay que volver a conectar.
- Si Google revoca el permiso (por ejemplo, lo quitás desde tu cuenta), la pestaña Copias lo avisa y las copias locales siguen funcionando.
- «Desconectar» revoca el permiso. Lo que ya está en tu Drive no se borra.
