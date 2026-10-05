# Publica ImageTo3D (autocontenido, win-x64) y genera el instalador con Inno Setup.
# Uso:  .\Compilar-ImageTo3D.ps1              -> publica y crea build\installer\ImageTo3D-Setup-<version>.exe
#       .\Compilar-ImageTo3D.ps1 -SinInstalador -> solo publica en build\publish
#       .\Compilar-ImageTo3D.ps1 -CerrarApp    -> cierra ImageTo3D si está abierto, sin preguntar
#       .\Compilar-ImageTo3D.ps1 -Instalar     -> además lo instala en este PC y lo abre
param(
    [switch]$SinInstalador,
    [switch]$CerrarApp,
    [switch]$Instalar
)

$ErrorActionPreference = 'Stop'
if ($PSScriptRoot) { $dir = $PSScriptRoot } else { $dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $dir

$proyecto = Join-Path $dir 'src\ImageTo3D\ImageTo3D.csproj'
$iss      = Join-Path $dir 'installer\ImageTo3D.iss'
$publish  = Join-Path $dir 'build\publish'
$exe      = Join-Path $publish 'ImageTo3D.exe'
$interactivo = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

function Salir([int]$codigo) {
    if ($interactivo) { Read-Host "Enter para salir" | Out-Null }
    exit $codigo
}

Write-Host ""
Write-Host "===== Compilar ImageTo3D =====" -ForegroundColor Cyan

$version = ([xml](Get-Content $proyecto)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
Write-Host "Versión $version  ·  SDK .NET $(dotnet --version)" -ForegroundColor DarkGray

# La app abierta bloquea el .exe publicado.
$abierta = Get-Process -Name 'ImageTo3D' -ErrorAction SilentlyContinue
if ($abierta) {
    $cerrar = $CerrarApp
    if (-not $cerrar -and $interactivo) { $cerrar = (Read-Host "ImageTo3D está abierto. ¿Cerrarlo para continuar? (S/N)") -match '^[SsYy]' }
    if (-not $cerrar) { Write-Host "Cancelado: cierra ImageTo3D (o usa -CerrarApp)." -ForegroundColor Red; Salir 1 }
    $abierta | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}

$crono = [Diagnostics.Stopwatch]::StartNew()
$pasos = if ($Instalar) { 3 } else { 2 }

# --- Publicación ---
Write-Host ""
Write-Host "[1/$pasos] Publicando (autocontenido, no necesita .NET instalado)..." -ForegroundColor Cyan
if (Test-Path $publish) {
    try { Remove-Item $publish -Recurse -Force -ErrorAction Stop }
    catch {
        # Files left by an elevated process (owner: Administradores) cannot be deleted from a
        # normal terminal. Publish to a fresh folder instead of shipping stale files.
        $publish = Join-Path $dir ("build\publish-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        $exe = Join-Path $publish 'ImageTo3D.exe'
        Write-Host "  No se pudo vaciar build\publish (archivos de un proceso con permisos de administrador)." -ForegroundColor Yellow
        Write-Host "  Se publica en $publish. Puedes borrar build\publish desde una terminal de administrador." -ForegroundColor Yellow
    }
}
dotnet publish $proyecto -c Release -r win-x64 --self-contained `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none `
    -o $publish --nologo --verbosity quiet
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) { Write-Host "ERROR al publicar." -ForegroundColor Red; Salir 1 }
$mbPublish = [math]::Round(((Get-ChildItem $publish -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "  $publish  ($mbPublish MB)" -ForegroundColor Green

if ($SinInstalador) { Write-Host ""; Write-Host "LISTO (sin instalador)." -ForegroundColor Green; Salir 0 }

# --- Instalador ---
Write-Host ""
Write-Host "[2/$pasos] Generando el instalador..." -ForegroundColor Cyan
$iscc = @(
    (Get-Command iscc -ErrorAction SilentlyContinue | ForEach-Object Source),
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) {
    Write-Host "No encuentro Inno Setup 6. Instálalo con:" -ForegroundColor Red
    Write-Host "  winget install --id JRSoftware.InnoSetup -e --scope user" -ForegroundColor Yellow
    Salir 1
}
& $iscc /Q "/DAppVersion=$version" "/DSourceDir=$publish" $iss
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR al generar el instalador." -ForegroundColor Red; Salir 1 }

$setup = Join-Path $dir "build\installer\ImageTo3D-Setup-$version.exe"

# --- Instalación en este PC ---
if ($Instalar) {
    Write-Host ""
    Write-Host "[3/3] Instalando en este PC..." -ForegroundColor Cyan
    # Encima de la instalación que ya haya: para todos los usuarios solo si es la única que existe
    # (entonces Windows pedirá permiso de administrador); si no, para tu usuario.
    $porUsuario = Join-Path $env:LOCALAPPDATA 'Programs\ImageTo3D\ImageTo3D.exe'
    $paraTodos  = Join-Path $env:ProgramFiles 'ImageTo3D\ImageTo3D.exe'
    $todos = (Test-Path $paraTodos) -and -not (Test-Path $porUsuario)
    $ambito = if ($todos) { '/ALLUSERS' } else { '/CURRENTUSER' }
    $instalado = if ($todos) { $paraTodos } else { $porUsuario }
    $proc = Start-Process $setup -ArgumentList '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', $ambito -PassThru -Wait
    if ($proc.ExitCode -ne 0 -or -not (Test-Path $instalado)) {
        Write-Host "ERROR al instalar (código $($proc.ExitCode))." -ForegroundColor Red
        Salir 1
    }
    Write-Host "  Instalada la versión $((Get-Item $instalado).VersionInfo.ProductVersion -replace '\+.*$', '') en $(Split-Path $instalado)" -ForegroundColor Green
    Start-Process $instalado
}
$crono.Stop()
Write-Host ""
Write-Host "LISTO en $([math]::Round($crono.Elapsed.TotalSeconds, 1)) s" -ForegroundColor Green
Write-Host "  $setup  ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)" -ForegroundColor Green
Salir 0
