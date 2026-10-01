#!/bin/bash
# Liu Vi - inicia el sistema en Mac con doble clic.
cd "$(dirname "$0")" || exit 1
# Si Terminal no trae las carpetas donde se instala Node (Homebrew / instalador oficial), se buscan ahí.
# Van al final: si el usuario ya tiene un Node configurado, se usa ese primero.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
PORT="${PORT:-3000}"

pausa() { echo; read -n 1 -s -r -p " Presioná una tecla para cerrar..."; echo; }

if ! command -v node >/dev/null 2>&1; then
  echo
  echo " No se encontró Node.js en esta computadora."
  echo " Instalalo desde https://nodejs.org (versión 22.13 o superior) y volvé a abrir este archivo."
  pausa; exit 1
fi

if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(+(a<22||(a==22&&b<13)))"; then
  echo
  echo " Tu versión de Node.js ($(node -v)) es muy vieja. Se necesita la 22.13 o superior."
  echo " Actualizala desde https://nodejs.org y volvé a abrir este archivo."
  pausa; exit 1
fi

echo
echo " Iniciando Liu Vi..."
echo " NO CIERRES ESTA VENTANA mientras uses el sistema."
echo " Para apagarlo, cerrá esta ventana o presioná Control + C."
echo

# El propio sistema abre el navegador cuando ya está funcionando (y no lo abre si hubo un problema).
export LIUVI_OPEN=1

node --disable-warning=ExperimentalWarning server.js

echo
echo " El sistema se detuvo. Si arriba dice que ya está abierto, usá la ventana que ya tenías."
pausa
