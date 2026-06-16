import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'dist', 'mcp');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'mcp', 'server.ts')],
  outfile: path.join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    // Alias the import to a private name so a bundled dep that also imports
    // `createRequire` can't collide with this banner — see build-server.mjs.
    js: "import { createRequire as __sbCreateRequire } from 'node:module'; const require = __sbCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  logLevel: 'info',
});

console.log('[build:mcp] done ->', outDir);
