# Architecture

GMF is a catalog-driven workbench for LLM agents. The catalog is the interface: every capability is a named operation with an input and output schema, declared effects and a gate. The CLI, the MCP server and skills all read the same catalog.

## Layers

- **Contracts and catalog.** `src/core/contracts.mjs` defines the operation, tool, knowledge, profile and plan shapes. `src/core/catalog.mjs` loads `catalog/*.json`. `scripts/build-catalog.mjs` generates the catalog from engine modules and source metadata and fails on drift.
- **Execution.** `src/core/operations.mjs` registers handlers and runs an operation with validated inputs. `src/core/bootstrap.mjs` loads the engine modules and registers their public operations before the CLI runs one. A result carries `data`, `evidence`, `effects`, `gate` and the authorization used.
- **State.** `src/core/workspace.mjs` owns `gmf.json` (committed identity), `gmf.local.json` (machine paths), `gmf.profile.json` (generated evidence) and `gmf.plan.json` (active plan). `src/core/evidence.mjs` creates evidence and unknown records. `src/core/authorization.mjs` maps effects to gates and resolves authorizations.
- **Tools and processes.** `src/core/tools.mjs` registers, installs, verifies and resolves external tools. `src/core/processes.mjs` runs owned child processes and stops them by process id.
- **Engine modules.** `src/engines/unity` and `src/engines/unreal` each export `detect`, `capabilities`, `operations`, templates and knowledge. A third engine is a new module, not a core edit.
- **Shared operations.** `src/operations` holds game, workspace, plan, verify, tool, knowledge, generic and analysis operations that are not specific to one engine. `src/operations/analyze/normalize.mjs` validates and writes the normalized dump that the analysis operations read; each engine has a `normalize_dump` operation that produces it.
- **Unreal tooling.** `src/engines/unreal/sig/` holds the PE parser, the x64 length decoder, the signature emitter and the PatternSleuth log parser behind `unreal.pe_analyze`, `unreal.aob_emit` and `unreal.aob_verify`. `crash.mjs` and `luacheck.mjs` back `unreal.crash_stack`, `unreal.lua_check` and `unreal.validate`.
- **Hooks.** `src/core/hooks.mjs` implements the host hook events: `session-start` prints the workspace context, `pre-write` blocks a write into the game folder, `decompiled/`, `extracted/`, `dumps/` or a loader binary, `post-bash` records the last validate run under `.gmf/`, and `stop` reminds about an edited but unvalidated mod. `gmf hook <event>` reads the host payload from stdin and never fails the session.
- **Knowledge and agent surface.** `knowledge/` holds engine and core notes with confidence labels. `skills/` and `agents/` hold the Agent Skills and role briefs. `src/core/hosts.mjs` and `scripts/sync.mjs` generate the Claude Code and Codex adapters from one source.

## Flow

1. `gmf investigate --game <dir>` runs detection and inventory, assembles a profile with evidence and unknowns, and writes it to the workspace. It never writes inside the game folder.
2. The LLM reads the profile, the catalog and the knowledge, and drafts a plan.
3. `gmf plan draft` writes a draft; `gmf plan validate` checks operation IDs, inputs, tools, effects and gates.
4. `gmf plan apply` runs the plan. Safe effects run automatically; soft effects need an authorization from the plan or the user's instruction; hard effects need explicit user approval.
5. `gmf verify` runs each step's verify command and records the result in the plan.

## Effects and gates

Operations declare one or more effects:

`read`, `workspaceWrite`, `gameWrite`, `toolInstall`, `network`, `launchGame`, `execute`, `destructive`, `antiCheat`, `credentials`, `piracy`.

- `auto`: `read`, `workspaceWrite`.
- `soft`: `gameWrite`, `toolInstall`, `network`, `launchGame`, `antiCheat`, `execute`. A plan authorization or a cited user instruction allows the action; the source is recorded.
- `hard`: `destructive`, `credentials`, `piracy`. The model cannot override; the user approves the exact action, and some actions are refused.

Anti-cheat is risk information and knowledge, not a block. A marker produces a `GMF-W-ANTICHEAT-001` warning and the operation proceeds under the normal soft gate.

## Tool integration

GMF does not reimplement loaders, decompilers or asset parsers. It registers and invokes BepInEx, MelonLoader, UE4SS, Cpp2IL, AssetRipper, AssetStudioModCLI, UnityPy, retoc, repak, UAssetGUI and REA. GPL tools are downloaded at runtime, never vendored. A tool entry declares its source, version policy, asset pattern, entry point, verification and effects.

## Extension points

- A new operation: add a descriptor and handler to an engine module or `src/operations`, then regenerate the catalog.
- A new engine: add `src/engines/<id>/index.mjs` with detection, capabilities, operations and templates.
- A new host: add an adapter in `src/core/hosts.mjs` and generate its manifests from the same skills and agents.
- A new knowledge note: add a Markdown file under `knowledge/` with frontmatter and run the catalog build. An engine note must name its origin in `sources`.
- A new skill: add `skills/<name>/SKILL.md` with `operations:` and `knowledge:` lists; the catalog build fails on an id that does not exist.
- A new template: add `templates/<engine>/<name>/template.json` with a `kind` of `scaffold`, `feature`, `helper` or `payload`.
