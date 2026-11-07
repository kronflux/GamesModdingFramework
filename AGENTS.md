# GMF project guide

GMF is an LLM-first catalog of modding operations, tools, knowledge, templates and skills. The catalog is the contract: read `gmf catalog --json` before inventing an operation.

## Rules

- Every capability is an operation with a stable ID, input and output schema, effects and a gate.
- Unity and Unreal are the first engine modules. A new engine is a module under `src/engines/`, not a core edit.
- Node.js 22 or later. No runtime npm dependencies. Tests use the built-in `node:test` runner.
- Never commit game content, decompiled code, loader binaries or extracted assets.
- Skills are host-neutral. Do not name host-only tools, paths or slash syntax.
- Anti-cheat is risk information and knowledge, not a gate. The user decides what to do with it.
- The workspace is separate from the game install: `gmf.json` is committed identity, `gmf.local.json` is machine paths, `gmf.profile.json` is generated evidence.
- Hard gates are destructive actions, credentials and piracy. Soft gates are game writes, tool installs, network access, game launches, anti-cheat interactions and running a program (`execute`).
- A soft gate may be overridden when the plan or the user's instruction authorizes the effect; the source is recorded.
- Write the test before the code when the behaviour is specified. Keep synthetic fixtures free of game content.
- Every command named in README, docs or a skill must exist; `test/cli-docs.test.mjs` runs them.
- Regenerate the catalog and the host files after a change: `npm run build-catalog` and `npm run sync`; `npm run check` fails on drift.

## Layout

- `src/core/` — contracts, catalog, operations, workspace, evidence, authorization, tools, processes, hooks.
- `src/engines/` — Unity and Unreal modules, each exporting detect, capabilities and operations.
- `src/operations/` — shared game, workspace, plan, verify, tool, knowledge, generic and analysis operations; `analyze/normalize.mjs` is the dump contract.
- `src/engines/unreal/sig/` — PE, disassembly, signature and PatternSleuth log parsing in Node.
- `catalog/` — generated catalog files. Fail CI on drift.
- `knowledge/`, `skills/`, `agents/`, `templates/` — the knowledge and agent surface. Engine notes name their origin in `sources`; skills list `operations` and `knowledge` ids that must exist; templates have a `kind`.
- `test/` — `node:test` suites and synthetic fixtures.
