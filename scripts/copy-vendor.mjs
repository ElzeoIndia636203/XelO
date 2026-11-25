import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const mediapipeSrc = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const mediapipeDest = resolve(root, 'public/vendor/mediapipe');
if (existsSync(mediapipeSrc)) {
  mkdirSync(mediapipeDest, { recursive: true });
  cpSync(mediapipeSrc, mediapipeDest, { recursive: true });
}

const pdfWorkerSrc = resolve(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
const pdfWorkerDestDir = resolve(root, 'public/vendor/pdfjs');
if (existsSync(pdfWorkerSrc)) {
  mkdirSync(pdfWorkerDestDir, { recursive: true });
  cpSync(pdfWorkerSrc, resolve(pdfWorkerDestDir, 'pdf.worker.min.mjs'));
}

const modelSrc = resolve(root, 'vendor-assets');
const modelDest = resolve(root, 'public/models');
if (existsSync(modelSrc)) {
  mkdirSync(modelDest, { recursive: true });
  cpSync(modelSrc, modelDest, { recursive: true });
}
