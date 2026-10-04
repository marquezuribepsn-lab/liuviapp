# Descarga la ventana de Liu Vi (Electron) y la descomprime. Lo llama el instalador; sale con 0 si todo salió bien.
param([string]$Url, [string]$Sha, [string]$Dest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $env:TEMP 'liuvi-ventana.zip'
  for ($i = 1; $i -le 3; $i++) {
    try { Write-Host "Descargando (intento $i de 3)..."; Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $zip; break }
    catch { if ($i -eq 3) { throw }; Start-Sleep -Seconds 3 }
  }
  Write-Host 'Verificando la descarga...'
  if ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash -ne $Sha.ToUpper()) { Write-Host 'La descarga llego danada (la suma no coincide).'; Remove-Item $zip -Force; exit 3 }
  Write-Host 'Descomprimiendo...'
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) { & $tar -xf $zip -C $Dest; if ($LASTEXITCODE -ne 0) { throw 'tar fallo' } }
  else { Expand-Archive -Force -Path $zip -DestinationPath $Dest }
  Remove-Item $zip -Force
  exit 0
} catch { Write-Host ('Error: ' + $_.Exception.Message); exit 2 }
