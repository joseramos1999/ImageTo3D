@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Compilando e instalando ImageTo3D en este PC (requiere el SDK de .NET 10 e Inno Setup 6)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Compilar-ImageTo3D.ps1" -Instalar %*
