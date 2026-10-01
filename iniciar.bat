@echo off
chcp 65001 >nul
title Liuvi - Sistema de ventas
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No se encontro Node.js en esta computadora.
  echo  Instalalo desde https://nodejs.org ^(version 22.13 o superior^) y volve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(+(a<22||(a==22&&b<13)))"
if errorlevel 1 (
  echo.
  echo  Tu version de Node.js es muy vieja. Se necesita la 22.13 o superior.
  echo  Actualizala desde https://nodejs.org y volve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

echo.
echo  Iniciando Liuvi...
echo  NO CIERRES ESTA VENTANA mientras uses el sistema.
echo  Para apagarlo, cerra esta ventana.
echo.

rem Abre el navegador unos segundos despues, cuando el sistema ya esta listo.
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

node --disable-warning=ExperimentalWarning server.js

echo.
echo  El sistema se detuvo. Si arriba dice que ya esta abierto, usa la ventana que ya tenias.
echo.
pause
