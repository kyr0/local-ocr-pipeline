#!/usr/bin/env node

import { exec, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { extname, join, dirname } from 'path';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PageResult {
  page: number;
  markdown?: string;
  invoiceJson?: string;
  error?: string;
}

class OllamaManager {
  ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  ocrModel = 'glm-ocr';
  jsonModel = 'qwen3:1.7b-q4_K_M';

  async checkOllamaInstalled(): Promise<boolean> {
    try {
      await execAsync('command -v ollama > /dev/null 2>&1');
      return true;
    } catch {
      return false;
    }
  }

  async ensureModelReady(model: string): Promise<void> {
    try {
      const { stdout } = await execAsync(`ollama list 2>&1 | grep "${model}"`);
      if (!stdout.includes(model)) {
        throw new Error('Model not installed');
      }
    } catch {
      console.log(`Pulling model ${model}...`);
      const child = spawn('ollama', ['pull', model], {
        stdio: 'inherit',
      });
      await new Promise((resolve, reject) => {
        child.on('close', (code: number) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`Failed to pull model: ${code}`));
        });
      });
    }
  }

  async runOCRWithImage(imagePath: string): Promise<string> {
    const { spawn: spawnChild } = await import('child_process');
    const child = spawnChild('ollama', ['run', this.ocrModel, `Text Recognition: <${imagePath}>`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });
      child.on('close', (code: number) => {
        if (code === 0) resolve(output.trim());
        else reject(new Error(`Ollama run failed: ${code}`));
      });
      child.on('error', reject);
      child.stdin.end();
    });
  }

  async convertMarkdownToJson(markdown: string, sellerAddress: string, sellerTaxNo: string): Promise<string> {
    const prompt = `You are an expert OCR data analyst and accountant. Extract invoice data from the following OCR'ed markdown and transform it into a ZUGFeRD invoice JSON format.

Seller address: ${sellerAddress}
Seller Tax ID: ${sellerTaxNo}

OCR'ed Markdown:
${markdown}

IMPORTANT: The unit can be:
- HUR: per hour (also called PT, MT)
- DAY: per day
- PCE: per unit

Tax percentages should be multiplied by 100 (e.g., 7% = 7.00, 19% = 19.00)

Return ONLY valid JSON matching this structure:
{
  "Invoice": {
    "InvoiceNumber": "string",
    "InvoiceDate": "YYYY-MM-DD",
    "DueDate": "YYYY-MM-DD",
    "Seller": {
      "Name": "string",
      "StreetName": "string",
      "City": "string",
      "PostalCode": "string",
      "CountryCode": "DE",
      "TaxIdentificationNumber": "string"
    },
    "Buyer": {
      "Name": "string",
      "StreetName": "string",
      "City": "string",
      "PostalCode": "string",
      "CountryCode": "DE",
      "TaxIdentificationNumber": "string"
    },
    "DocumentCurrencyCode": "EUR",
    "PaymentMeans": {
      "Type": "42",
      "PaymentInformation": {
        "PaymentReceiver": "string",
        "IBAN": "string",
        "BIC": "string",
        "BankName": "string",
        "PaymentReference": "string"
      }
    },
    "Tax": {
      "TaxTypeCode": "VAT",
      "TaxCategoryCode": "S",
      "TaxPercentage": 0.0,
      "TaxAmount": 0.0
    },
    "MonetarySummation": {
      "LineTotal": 0.0,
      "TaxExclusiveAmount": 0.0,
      "TaxInclusiveAmount": 0.0,
      "PayableAmount": 0.0
    },
    "InvoiceLines": [
      {
        "LineID": "1",
        "ProductName": "string",
        "Unit": "HUR"|"DAY"|"PCE",
        "Quantity": 0.0,
        "UnitPrice": 0.0,
        "LineTotalAmount": 0.0,
        "TaxCategoryCode": "S",
        "TaxPercentage": 0.0
      }
    ]
  }
}
`;
    const response = await fetch(`${this.ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.jsonModel,
        prompt: prompt,
        stream: false,
        options: {
          num_ctx: 10240
        }
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama generate failed: ${response.status}`);
    }

    const data = await response.json();
    return data.response.trim();
  }
}

async function detectFileType(filePath: string): Promise<'pdf' | 'image'> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return 'image';
  throw new Error(`Unsupported file type: ${ext}`);
}

async function convertPdfToImages(
  pdfPath: string,
  tempDir: string
): Promise<string[]> {
  console.log(`Converting PDF to images: ${pdfPath}`);
  
  const { pdf } = await import('pdf-to-img');
  const pdfBuffer = readFileSync(pdfPath);
  
  const document = await pdf(pdfBuffer, { scale: 1 });
  const pageCount = document.length;
  
  const imagePaths: string[] = [];
  
  let counter = 1;
  for await (const pageBuffer of document) {
    const outputPath = join(tempDir, `page_${counter}.jpg`);
    writeFileSync(outputPath, pageBuffer);
    imagePaths.push(outputPath);
    counter++;
  }
  
  console.log(`Extracted ${pageCount} pages from PDF`);
  return imagePaths;
}

async function resizeImageToMaxMP(
  inputPath: string,
  outputPath: string,
  maxMP = 3
): Promise<void> {
  const Jimp = await import('jimp');
  const image = await Jimp.default.read(inputPath);
  
  const currentMP = (image.getWidth() * image.getHeight()) / 1_000_000;
  if (currentMP <= maxMP) {
    writeFileSync(outputPath, readFileSync(inputPath));
    return;
  }
  
  const scale = Math.sqrt(maxMP / currentMP);
  const newWidth = Math.floor(image.getWidth() * scale);
  const newHeight = Math.floor(image.getHeight() * scale);
  
  image.resize(newWidth, newHeight);
  const buffer = await image.getBufferAsync(Jimp.default.MIME_JPEG);
  writeFileSync(outputPath, buffer);
}

function parseArgs(): {
  input: string;
  output?: string;
  sellerAddress: string;
  sellerTaxNo: string;
} {
  const args = process.argv.slice(2);
  const result = {
    input: '',
    output: '',
    sellerAddress: '',
    sellerTaxNo: '',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      result.input = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      result.output = args[++i];
    } else if (args[i] === '--seller-address' && args[i + 1]) {
      result.sellerAddress = args[++i];
    } else if (args[i] === '--seller-tax-no' && args[i + 1]) {
      result.sellerTaxNo = args[++i];
    }
  }

  if (!result.input) {
    console.error('Usage: ocr-pipeline --input <file> [--output <file>] [--seller-address <addr>] [--seller-tax-no <taxno>]');
    process.exit(1);
  }

  return result;
}

async function main() {
  const { input, output, sellerAddress, sellerTaxNo } = parseArgs();

  const ollama = new OllamaManager();

  console.log('Ensuring Ollama is available...');
  const ollamaInstalled = await ollama.checkOllamaInstalled();
  if (!ollamaInstalled) {
    console.error('Ollama not found. Please run setup.sh or setup.bat first.');
    process.exit(1);
  }

  console.log(`Ensuring OCR model ${ollama.ocrModel} is available...`);
  await ollama.ensureModelReady(ollama.ocrModel);

  console.log(`Ensuring JSON conversion model ${ollama.jsonModel} is available...`);
  await ollama.ensureModelReady(ollama.jsonModel);

  const fileType = await detectFileType(input);
  
  const tempDir = join(__dirname, '.tmp_' + createHash('md5').update(input + Date.now()).digest('hex'));
  
  try {
    mkdirSync(tempDir, { recursive: true });
    
    let imagePaths: string[] = [];

    if (fileType === 'pdf') {
      imagePaths = await convertPdfToImages(input, tempDir);
    } else {
      imagePaths = [input];
    }

    const results: PageResult[] = [];

    for (let i = 0; i < imagePaths.length; i++) {
      console.log(`Processing page ${i + 1}/${imagePaths.length}...`);
      
      const inputPath = imagePaths[i];
      const outputPath = join(tempDir, `resized_${i}.jpg`);
      
      await resizeImageToMaxMP(inputPath, outputPath, 3);
      
      try {
        console.log('Running OCR...');
        const markdown = await ollama.runOCRWithImage(outputPath);
        
        const metadata = `Seller address: ${sellerAddress}\nSeller Tax ID: ${sellerTaxNo}\n`;
        const fullMarkdown = metadata + markdown;
        
        console.log('Converting to JSON...');
        const invoiceJson = await ollama.convertMarkdownToJson(fullMarkdown, sellerAddress, sellerTaxNo);
        
        results.push({
          page: i + 1,
          markdown: fullMarkdown,
          invoiceJson,
        });
        console.log(`Page ${i + 1} processed successfully`);
      } catch (error) {
        results.push({
          page: i + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(`Page ${i + 1} failed: ${error}`);
      }
    }

    const outputJson = JSON.stringify(results.map(r => r.invoiceJson || r.error), null, 2);

    if (output) {
      writeFileSync(output, outputJson);
      console.log(`Results written to ${output}`);
    } else {
      console.log(outputJson);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
