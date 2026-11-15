// Dependencias vendorizadas: rutas y SHA-256 esperados (ver vendor/VENDOR.md).
// Si un hash no coincide, el hook falla cerrado.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR = path.join(HERE, '..', 'vendor');

export const VENDOR_FILES = {
  'web-tree-sitter/web-tree-sitter.js': '7c49e3c1d87e24e0bb4c2def909d17154dfde281f5f8280225450090bb4b8110',
  'web-tree-sitter/web-tree-sitter.wasm': 'beca80e44cccbf2299ed4d1e3fa6462a9a6fe818aeebf847547a392227ce4acc',
  'tree-sitter-bash/tree-sitter-bash.wasm': '8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a',
};

let verified = false;

/** Verifica los hashes una vez por proceso. Lanza si falta o no coincide un archivo. */
export function verifyVendor() {
  if (verified) return;
  for (const [rel, expected] of Object.entries(VENDOR_FILES)) {
    const full = path.join(VENDOR_DIR, rel);
    const got = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (got !== expected) throw new Error(`vendor ${rel}: SHA-256 no coincide`);
  }
  verified = true;
}

export const vendorPath = (rel) => path.join(VENDOR_DIR, rel);
