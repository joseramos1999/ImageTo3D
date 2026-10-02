@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Creando el instalador de ImageTo3D (requiere el SDK de .NET 10 e Inno Setup 6)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Compilar-ImageTo3D.ps1" %*
