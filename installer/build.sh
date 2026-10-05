#!/usr/bin/env bash
# Arma el instalador de Windows (Liu-Vi-Setup-<versión>.exe). Corre en Linux o Mac; necesita: makensis (NSIS 3), python3 con Pillow, curl, unzip, git.
#   sudo apt install nsis unzip      (Linux)      |      brew install makensis      (Mac)
# Uso:  installer/build.sh [carpeta de salida]
set -euo pipefail
OUT="$(mkdir -p "${1:-$(dirname "$0")/dist}" && cd "${1:-$(dirname "$0")/dist}" && pwd)"
cd "$(dirname "$0")/.."
NODE_VERSION="${NODE_VERSION:-22.22.0}"      # el motor que se incluye (hace falta 22.13 o más)
ELECTRON_VERSION="${ELECTRON_VERSION:-39.2.0}" # la ventana propia de la aplicación (Electron); el sistema sigue corriendo con el Node de arriba
VERSION="$(node -p "require('./package.json').version")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/liuvi-installer"; mkdir -p "$CACHE"

# 1. Motor (Node.js oficial para Windows 64 bits), verificado contra la suma publicada por nodejs.org
ZIP="node-v$NODE_VERSION-win-x64.zip"
if [ ! -f "$CACHE/$ZIP" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$ZIP" -o "$CACHE/$ZIP"
fi
EXPECTED="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$ZIP" '$2==f{print $1}')"
[ -n "$EXPECTED" ] && [ "$(sha256sum "$CACHE/$ZIP" | cut -d' ' -f1)" = "$EXPECTED" ] || { echo "La suma de $ZIP no coincide"; rm -f "$CACHE/$ZIP"; exit 1; }
mkdir -p "$WORK/stage/runtime"
unzip -q -j "$CACHE/$ZIP" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$WORK/stage/runtime"
mv "$WORK/stage/runtime/LICENSE" "$WORK/stage/runtime/LICENSE-node.txt"

# 1b. Ventana de escritorio (Electron): NO va dentro del instalador (pesa más de 100 MB); el instalador la descarga de GitHub y verifica esta suma.
EZIP="electron-v$ELECTRON_VERSION-win32-x64.zip"
EURL="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/$EZIP"
ESHA="$(curl -fsSL "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/SHASUMS256.txt" | awk -v f="$EZIP" '$2=="*"f{print $1}')"
[ -n "$ESHA" ] || { echo "No se pudo obtener la suma de $EZIP"; exit 1; }
EMB="$(curl -fsSIL "$EURL" | awk 'tolower($1)=="content-length:"{n=$2} END{printf "%d", n/1048576}')"; [ "${EMB:-0}" -gt 0 ] || EMB=115
mkdir -p "$WORK/stage/shell/resources/app"

# 1c. rcedit (cambia el ícono y el nombre del .exe de la ventana al instalar: sin esto la barra de tareas muestra el ícono de Electron)
RCEDIT_SHA="3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a"
if [ ! -f "$CACHE/rcedit-x64.exe" ]; then curl -fsSL "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe" -o "$CACHE/rcedit-x64.exe"; fi
[ "$(sha256sum "$CACHE/rcedit-x64.exe" | cut -d' ' -f1)" = "$RCEDIT_SHA" ] || { echo "La suma de rcedit no coincide"; rm -f "$CACHE/rcedit-x64.exe"; exit 1; }

# 2. El programa (lo que está en el repositorio, incluidos cambios sin guardar en git, sin pruebas ni herramientas de desarrollo)
git ls-files -z --cached --others --exclude-standard | tar --null -T - -c | tar -x -C "$WORK/stage"
cp electron/main.cjs electron/package.json "$WORK/stage/shell/resources/app/"
(cd "$WORK/stage" && rm -rf test installer electron .github .gitattributes .gitignore iniciar.command iniciar.bat)
cp installer/liuvi.vbs installer/detener.vbs "$WORK/stage/"
# Credenciales de Google (si existen): el instalador las trae y en cada PC alcanza con «Conectar con Google». No van al repositorio.
if [ -n "${GOOGLE_CLIENT_JSON:-}" ] && [ -f "$GOOGLE_CLIENT_JSON" ]; then cp "$GOOGLE_CLIENT_JSON" "$WORK/stage/google-client.json"; elif [ -f installer/google-client.json ]; then cp installer/google-client.json "$WORK/stage/google-client.json"; fi

# 3. Imágenes y compilación
python3 installer/make-assets.py "$WORK/assets"
makensis -V2 -DVERSION="$VERSION" -DSTAGE="$WORK/stage" -DASSETS="$WORK/assets" -DELECTRON_VERSION="$ELECTRON_VERSION" -DELECTRON_URL="$EURL" -DELECTRON_SHA="$ESHA" -DELECTRON_MB="$EMB" -DRCEDIT="$CACHE/rcedit-x64.exe" -DSHELL_PS1="$PWD/installer/get-shell.ps1" -DOUTFILE="$OUT/Liu-Vi-Setup-$VERSION.exe" installer/liuvi.nsi
ls -la "$OUT/Liu-Vi-Setup-$VERSION.exe"
