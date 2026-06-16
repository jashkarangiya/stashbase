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
    // Same story: @vscode/ripgrep resolves its platform binary package
    // (@vscode/ripgrep-{platform}-{arch}) via require.resolve relative to
    // its own import.meta.url. Bundling rewrites that base to dist/server/,
    // where pnpm hasn't symlinked the platform pkg → "Could not find
    // @vscode/ripgrep-darwin-arm64" at boot. Keep it external so it loads
    // from packaged node_modules and resolves its sibling binary.
    '@vscode/ripgrep',
  ],
  banner: {
    // Provide a CJS `require` in the ESM bundle. Alias the import to a
    // private name: the banner is raw text esbuild can't see, so a bundled
    // dep that also does `import { createRequire } from "node:module"`
    // (e.g. @vscode/ripgrep) would otherwise hoist a second top-level
    // `createRequire` and collide → "Identifier already declared" at boot.
    js: "import { createRequire as __sbCreateRequire } from 'node:module'; const require = __sbCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  logLevel: 'info',
});

console.log('[build:server] done ->', outDir);
