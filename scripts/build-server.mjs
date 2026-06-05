import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'dist', 'server');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  outfile: path.join(outDir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    // Native module rebuilt by electron-builder and loaded from packaged node_modules.
    'better-sqlite3',
    // Ships its own `cli.js` that it locates relative to its own package
    // dir at runtime — bundling it into one file breaks that resolution,
    // so load it from packaged node_modules like the native modules above.
    '@anthropic-ai/claude-agent-sdk',
  ],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  sourcemap: true,
  logLevel: 'info',
});

console.log('[build:server] done ->', outDir);
