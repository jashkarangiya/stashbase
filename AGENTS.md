# Agent Maintenance Contract

Before writing code, read the relevant files under `design-docs/`.
Use `design-docs/architecture.md` for module placement and data flow. If
the module map marks a touched file as red, read the matching
`design-docs/data-layer.md` section 8 entry first. Use `data-layer.md` for
consistency, caches, lifecycle, process ownership, and liveness constraints.

Keep the design docs current as part of relevant code changes. Do not run a
standalone documentation pass unless the user explicitly asks for one.

## Design Docs And Mirrors

`design-docs/` is the local working copy and is gitignored. Published mirrors
live in Feishu:

- `architecture.md`: https://icnrl0icvns2.feishu.cn/wiki/Oi6PwGdwgiqNSQkijoic673Mnob
- `data-layer.md`: https://icnrl0icvns2.feishu.cn/wiki/KE2xw8pN0iJW6Fka9nMc6i9cnmg
- `overview.md`: https://icnrl0icvns2.feishu.cn/wiki/KRDhw1SqriUj5JkNHDLcR9uunyc

When editing `architecture.md` or `data-layer.md`, sync Feishu in the same
session with `lark-cli docs +update --api-version v2`. These two mirrors are
text-only, so full-document overwrite with converted Feishu XML is preferred.
Never overwrite `overview.md`; it contains images. Use targeted
`str_replace` edits only.

Use cases live in the Feishu Bitable at wiki
`TyXgwJazMiE12vk9mJ3cFB0inB3`, not in a local file. Read and update it with
`lark-cli base`, not Feishu MCP tools. Base/table:
`MpjWbcQPsak3ZHs1d60cmJ36nxD` / `tblNPl6yxXvBJ8RJ`.

Keep the two status columns distinct:

- `状态`: whether the feature is built.
- `测试状态`: whether the current use-case definition has been verified.

When changing a use-case definition, reset `测试状态` to `未测试`.

## Documentation Boundaries

- `overview.md`: product motivation, principles, solution shape, competitive
  read. Update only for positioning, principles, product scope, or core model
  changes.
- `architecture.md`: module map, data flows, TS/Python/MCP/Electron
  boundaries, extension points, indexing/store/embedder details, and design
  decisions. Update when module boundaries, data flows, abstractions, schemas,
  defaults, or important workflows change.
- `data-layer.md`: ownership, consistency, identity, sync/export,
  deletion/recovery, concurrency, caches, await graphs, timing windows,
  invariants, and incidents. Section 8 is as-is only; claims need `file:line`
  support and suspect behavior should be tagged with `⚠️`.

Code is the source of truth. If behavior changes, update the relevant doc in
the same change. Avoid duplication across docs. Keep `README.md` short and
external-facing; link into the design docs rather than expanding it.

## Development Loop

For bug reports and feature requests, run the full loop without hand-holding:

1. Locate and diagnose the issue from code and relevant design docs. For
   red-marked files in the architecture module map, read the matching
   `data-layer.md` section 8 entry first.
2. Implement within the documented constraints: context-free sync/conversion,
   hidden derived notes never surface, single-daemon ownership, and credentials
   only in Settings, never environment variables.
3. Verify before reporting done:
   - Always run `npx tsc --noEmit`.
   - For server changes, run `pnpm test:import-folder`.
   - For renderer changes, run `npx vite build --config web-src/vite.config.ts`.
4. Update affected design docs in the same change and sync Feishu as required.
   Update README or build-map copy when user-visible behavior changes.
5. Leave work uncommitted unless the user asks to commit.

## Commit Protocol

When the user asks to commit, group the dirty tree into focused commits by
theme: feature, fix, refactor, docs, or chore. Do not bundle unrelated work.
Use the existing style:

- `fix(scope): ...`
- `feat(scope): ...`
- `refactor(scope): ...`
- `docs(scope): ...`
- `chore: ...`

If a file carries multiple unrelated themes, split hunks so each commit is
coherent and can compile and test independently. Do not push unless the user
asks to push or the action is part of a release.

## Release Procedure

When the user says `发版`, `打包`, or `release`, prepare everything, then hand
`pnpm dist:brew` to the user. The user runs that command, not the agent.

Release protocol:

1. Tidy commits first. Run `git status` and `git log --oneline -10`. If the
   working tree is dirty, group changes into focused commits in the existing
   commit style. Push is part of release preparation; ensure `main` is pushed
   before tagging.
2. Ask the user for the version bump: patch, minor, or major, derived from the
   current `package.json` version. This should be the only question in the
   release flow.
3. Commit the version bump as `chore: bump to <new-version>`.
4. Hand off: tell the user to run `pnpm dist:brew`; suggest `--dry-run` first
   if setup looks unusual.
5. After the user reports completion, verify with `gh release view v<version>`.
   Confirm the DMG asset exists and the Homebrew tap commit landed. Report the
   release URL.

Manual commands for the user:

```bash
pnpm dist:brew
gh release view v<X.Y.Z>
```

Fresh-machine prerequisite: `brew install gh && gh auth login`.

Known release failures:

- Codesign reports `bundle format is ambiguous (Mantle.framework)`: Electron
  framework symlinks were flattened. Fix with
  `rm -rf node_modules/electron/dist && node node_modules/electron/install.js`.
- Codesign reports resource fork or Finder information detritus: iCloud xattr
  tagging is leaking in. Keep artifacts under `release.nosync/` and preserve
  the afterPack `ditto --noextattr` clone before signing.

Never commit the DMG. `release.nosync/` is gitignored. Build internals live in
`scripts/package-unsigned.mjs` and `scripts/build-python-sidecar.mjs`; read
their headers before changing package behavior.
