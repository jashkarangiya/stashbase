# Claude maintenance contract for this repo

**Before writing code, consult `design-docs/` first** — especially:
module placement and data flows → `architecture.md` (its module map marks
🔴 files; touching one means reading the matching `data-layer.md` §8
section first); anything about consistency, caches, or process lifecycle →
`data-layer.md`. The docs encode constraints (context-free sync, hidden
derived notes never surface, single-daemon ownership, …) that code review
will enforce.

You are responsible for keeping the **three design docs** under
`design-docs/` up to date. Update them as a side effect of relevant code
changes — never as a standalone "documentation pass". If a change touches
the surface area one of these docs covers, edit that doc in the same change.

## The design docs are the source of truth

`design-docs/` is the single, committed home of the design docs — there is
no external mirror to keep in sync. When you change behaviour, update the
affected doc **in the same change** (see the development loop below); reading
and writing them is purely local file work.

Keep them in **English** — these files are committed, so do not introduce
Chinese prose into them.

User-visible **use-case** flows are NOT maintained here. They live in a
separate, manually-run process (`update-use-cases.md`, gitignored) and are
**out of scope for the automatic doc-update loop** — never touch them as a
side effect of a code change.

## The three documents

### 1. `design-docs/overview.md` — product motivation & vision

What it covers: the problem, product principles, the solution shape, and the
competitive read — "why StashBase exists and what it is" at a product level.

Update it when: positioning shifts, a principle changes, or the solution's
scope / core model changes. Not for incremental features or implementation
detail.

### 2. `design-docs/architecture.md` — system design

What it covers: the module map, where each concern lives, how data flows
between TS / Python / MCP / Electron, the load-bearing extension points, the
indexing / store / embedder technical details (MFS behaviour, Milvus schema,
chunker).

**Describe only the current state.** No changelog / before-after / "we
removed X" / "now fixed" / "V2 may add Y" framing — state what the system
*is* today; if something no longer exists, simply don't mention it. (One
machine = one environment = one library; there is no multi-library model.)

Update it when: module boundaries change (new file under `server/` or
`web-src/src/`), a data flow shifts (e.g. a route moves from sync to fire-and-
forget), a key abstraction changes (the `Indexer` interface, the store shape),
MFS upstream changes something we depend on, the embedder default or Milvus
schema changes, or a workflow someone else would need to find by reading is
introduced.

Do **not** put: user-visible use-case flows (those are maintained separately,
see above) or product motivation (that goes in overview.md).

### 3. `design-docs/data-layer.md` — data ownership & liveness

What it covers: the data seen as data — classification & ownership, the
consistency / reconcile model, identity (hashing), sync & export, lifecycle /
deletion / recovery, AND the as-is concurrency layer (§8: process topology,
runtime caches & invalidation, state machines, the await graph, timing
windows, the invariant list I1-I7, incident archive). architecture.md says
where things live and how flows connect; data-layer.md says when data can go
wrong and who guarantees it doesn't.

Update it when: a source of truth or cache changes (new derived copy, new
invalidation signal), a process/lifecycle state machine gains or loses a
state or edge, an await/barrier/queue is added or gets a timeout, a timing
window (debounce/TTL) changes, an invariant gains or loses enforcement, or a
liveness incident teaches something (append to the incident archive).

Discipline specific to §8: as-is only, claims carry `file:line`, suspect
behaviour is tagged `⚠️` instead of silently rationalised.

## Norms across the docs

- **Source-of-truth precedence**: code > docs. If you change behaviour, fix
  the doc in the same change. Don't write a doc for behaviour that isn't
  shipping yet.
- **Concision**: every paragraph should pay rent. Cut whatever doesn't.
- **No duplication across the docs**: each topic lives in one doc and is
  cross-referenced from the others.
- **Language**: English only — these docs are committed. Technical terms and
  identifiers stay as-is.

## README

`README.md` is the external-facing entry. Keep it short; link into the
design docs above.

## Development loop (bug / feature requests)

When the user reports a bug or asks for a feature, run the full loop
without hand-holding:

1. **Locate & diagnose** — reproduce from code reading; for 🔴-marked
   files (architecture.md module map) read the matching data-layer §8
   section first. Report root cause when the user asked a question;
   fix directly when they asked for a fix.
2. **Implement**, respecting the documented constraints (context-free
   sync/conversion, hidden derived notes never surface, single-daemon
   ownership, credentials only in Settings — never env).
3. **Verify — never report done without this**:
   - `npx tsc --noEmit` (always)
   - `npx vite build --config web-src/vite.config.ts` (renderer changes)
4. **Update the affected design docs in the same change** (local
   `design-docs/` only — there is no external mirror). Update README /
   build map copy when user-visible behaviour changed.
5. Leave the work **uncommitted** — committing happens when the user
   says so (next section).

## Commit protocol

When the user asks to commit (in any language): group the dirty
tree into **focused
commits by theme** — feature / fix / refactor / docs separately, never
unrelated work bundled. Match the existing style: `fix(scope): …`,
`feat(scope): …`, `refactor(scope): …`, `docs(scope): …`, `chore: …`.
Mixed files (one file carrying two themes) may be split by temporarily
restoring + re-applying hunks so each commit compiles on its own.
Do NOT push — push only when the user says push, or as
part of a release.

## Release procedure

**When the user asks to release / package a build (in any language):
prepare everything, then have them publish a GitHub Release for the matching
`v<X.Y.Z>` tag.** Packaging is release-only: GitHub Actions builds and uploads
the macOS and Linux installers from the tag; Windows has a placeholder workflow
until it is supported. `pnpm dist:brew` remains the local macOS fallback, but it
is no longer the default release path. The scripts under `scripts/publish-*.mjs`
are implementation details, not the public surface.

Protocol, in order:

1. **Tidy commits first.** Run `git status` + `git log --oneline -10`.
   If the working tree is dirty, group the changes into focused commits
   using the surrounding style (`fix(scope): …`, `feat(scope): …`,
   `chore: …`). Don't bundle unrelated work into one commit. Push is
   part of the release — make sure main is pushed before tagging.
2. **Ask the version bump** via `AskUserQuestion` (patch / minor /
   major derived from `package.json` `version`). This is the ONE
   question in the flow; everything after runs unattended.
3. **Commit the bump** as a standalone `chore: bump to <new-version>`.
4. **Hand off**: tell the user to publish the GitHub Release for
   `v<version>` (or manually run the `Release macOS` / `Release Linux`
   workflows with that tag to backfill assets). The macOS workflow requires
   `HOMEBREW_TAP_TOKEN` with push access to `liliu-z/homebrew-stashbase`.
5. **Verify when Actions finish** (or when asked): `gh release view
   v<version>` — DMG/zip and deb assets attached, tap commit landed.
   Release notes are auto-generated and state: macOS arm64 (Apple Silicon)
   only, unsigned — first launch is blocked by Gatekeeper; run the bundled
   `Fix.sh` (user-facing instructions ship in the DMG as
   `build/dmg-scripts/Read Me.txt`). Report the release URL.

Commands:

```bash
pnpm dist:brew            # local fallback only (add --dry-run to preview)
gh release view v<X.Y.Z>  # verify release assets after Actions finish
```

Prereq on a fresh machine: `brew install gh && gh auth login` (asset
upload uses `gh` when `GITHUB_TOKEN` is unset). Known failure modes:
- codesign "bundle format is ambiguous (Mantle.framework)" = the
  Electron dist's framework symlinks got flattened — fix with
  `rm -rf node_modules/electron/dist && node node_modules/electron/install.js`.
- codesign "resource fork / Finder information detritus" = iCloud
  xattr-tagging (the repo lives under ~/Documents, which syncs).
  Two-layer defence, keep both: output dir is `release.nosync/`
  (.nosync keeps iCloud off the artifacts), and afterPack ditto-clones
  the .app with --noextattr before signing (xattr -cr alone can NOT
  strip fileprovider tags — fileproviderd re-applies them).

Never commit the DMG. `release.nosync/` is gitignored; builds belong there
only. Build internals live in `scripts/package-unsigned.mjs` /
`scripts/build-python-sidecar.mjs` (read the headers, don't guess).
