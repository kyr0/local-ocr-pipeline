@echo off
setlocal

echo === OCR Pipeline Setup ===

where ollama >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Ollama already installed
) else (
    echo Installing Ollama...
    curl -fsSL https://ollama.com/install.sh | sh
)

echo Pulling glm-ocr model...
ollama pull glm-ocr

where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
    echo Node.js installed: %NODE_VERSION%
) else (
    echo Node.js not found. Installing...
    winget install OpenJS.NodeJS.LTS
)

where pnpm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Installing pnpm...
    npm install -g pnpm
)

echo Installing dependencies...
pnpm install

echo Build complete!
