import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const targets = [
  'dist/pyinstaller',
  'python/pyinstaller-cache.nosync',
  'python/sidecar.nosync',
];

for (const target of targets) {
  const abs = path.join(root, target);
  fs.rmSync(abs, { recursive: true, force: true });
  console.log(`[clean:python-build] removed ${target}`);
}
