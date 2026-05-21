#!/usr/bin/env node
/**
 * Export the **currently open** space's chunk index to
 * `<space>/.stashbase/snapshot.parquet`. Used by starter-pack
 * maintainers to ship a pre-built index downstream — `git clone`-ing
 * the repo preserves the snapshot (see `pruneClonedStashbase` in
 * `server/routes/space.ts`), and the next user's app auto-imports it
 * on bind, skipping the re-embed.
 *
 * Usage (StashBase running on localhost:8090):
 *   node scripts/export-snapshot.mjs                  # exports current space
 *   node scripts/export-snapshot.mjs --port=8091      # custom port
 */
const args = process.argv.slice(2);
const port = (() => {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--port=')) return Number(args[i].slice(7));
    if (args[i] === '--port' && args[i + 1]) return Number(args[i + 1]);
  }
  return 8090;
})();

const base = `http://127.0.0.1:${port}`;
try {
  const r = await fetch(`${base}/api/space/export-snapshot`, { method: 'POST' });
  if (!r.ok) {
    const body = await r.text();
    console.error(`export failed (${r.status}): ${body}`);
    process.exit(1);
  }
  const data = await r.json();
  console.log(`wrote ${data.chunks} chunk(s) → ${data.path}`);
  for (const p of data.providers ?? []) {
    console.log(`  ${p.provider} (dim=${p.dim}): ${p.chunks}`);
  }
  console.log('');
  console.log('Commit `.stashbase/snapshot.parquet` to your repo so downstream');
  console.log('clones get a pre-built index (auto-imported on first open).');
} catch (err) {
  console.error(`couldn't reach ${base}/api/space/export-snapshot — is StashBase running?`);
  console.error(err.message ?? err);
  process.exit(1);
}
