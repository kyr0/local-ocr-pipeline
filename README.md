# Local OCR Pipeline

## Setup

Prereqs:
- Node.js 18+
- Ollama

macOS/Linux:
```bash
./setup.sh
```

Windows:
```bat
setup.bat
```

## Run OCR test

Uses the included sample file:
```bash
pnpm test
```

Custom run example:
```bash
pnpm start -- --input test.pdf --seller-address "Test Address" --seller-tax-no "123456789"
```

## Run with Ollama Host

```bash
OLLAMA_HOST=http://baradcuda:11435 OCR_MODEL=glm-ocr-64k JSON_MODEL=qwen3:1.7b-q4_K_M pnpm start -- --input test.pdf --seller-address "Test Address" --seller-tax-no "123456789"
```