@echo off
rem Background Image Control pack: bundle extension -> build vsix -> auto install
rem NOTE: bump VER together with extension\package.json version and vsix\extension.vsixmanifest Version
rem Pack uses pack.ps1 (PowerShell ZipArchive) because tar treats [Content_Types].xml as a glob pattern
setlocal
cd /d "%~dp0"
set VER=1.3.0

if not exist dist mkdir dist
powershell -NoProfile -ExecutionPolicy Bypass -File pack.ps1 -Version %VER%
if errorlevel 1 (echo vsix failed & exit /b 1)
if not exist dist\background-image-control-%VER%.vsix (echo vsix failed & exit /b 1)

rem ---- auto install ----
where code >nul 2>nul
if errorlevel 1 (
    echo [WARN] code CLI not found - install manually: dist\background-image-control-%VER%.vsix
) else (
    code --install-extension dist\background-image-control-%VER%.vsix --force
    if errorlevel 1 (echo install failed & exit /b 1) else (echo INSTALLED: background-image-control-%VER% - Reload Window to activate)
)
