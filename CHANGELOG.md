# Changelog

## Unreleased

### Unreal first dump

- GmfDumper is a full dumper mod with a Lua part and a C++ part, ported from OmniDumper commit 42ea496. It runs by itself once the game reaches its menu, holds input, writes one run folder `<ue4ss>/Dumps/<Game>-<engine>-<timestamp>/` with `manifest.json` and, last, `run_complete.json`, and closes the game. The console command is `gmfdump [full|quick|list|help|<step> ...]`; options and the key bind are in `Mods/GmfDumper/config.lua`.
- New operations: `unreal.run_dump` (needs `gameWrite` and `launchGame`; status `complete`, `empty`, `crashed`, `exited` or `running`; never stops the game), `unreal.verify_dump`, `unreal.read_containers` and `unreal.build_docs`. `unreal.deploy_dumper` also installs the native part and reports `native` as `installed`, `mismatch`, `unknown`, `unavailable` or `not_authorized`. `unreal.setup_ue4ss` writes `gmf-install.json` with the installed UE4SS release. `unreal.dump` with `collect=true` collects the newest complete run into `dumps/unreal/runs/<run>/`.
- The native part is built by `.github/workflows/gmfdumper.yml` and published as the rolling release `gmfdumper-latest`. The workflow rebuilds when the `experimental-latest` UE4SS asset or `native/gmfdumper` changes.
- A Node docs builder turns a run into Markdown pages under `gamedocs/`; start at `gamedocs/overview.md`. The skill `unreal-first-dump` and the knowledge notes `unreal.gamedocs`, `unreal.gmfdumper.native`, `unreal.asset-export` and `unreal.blueprint-mods.suzie` describe the flow.
- The pre-write hook judges loader-looking file names only inside the workspace, and guards `gamedocs/` like `dumps/`. The session start message points at `gamedocs/overview.md` when it exists.
- Removed: the old GmfDumper wrapper and its `GmfDumper_report.txt`.
- `unreal.setup_ue4ss` on an existing install keeps the user's `UE4SS-settings.ini` values (for example `GraphicsAPI = dx11`) for every key the new release still has, and their `Mods/mods.txt` choices; it reports them as `keptSettings` and `keptModStates`. Before, an update reset both to the release defaults.
- `unreal.build_docs` writes `console/`: console variable names read from the game executable, by prefix, with the values the game's ini files set. Input `gameExe` overrides the executable; the default is the run's `game_exe`, then the profile's. A live dump of the console variable registry is not included: UE4SS does not expose the console manager, and shipping builds compile out the commands that list it.

## 0.1.0

First public release.

### What gmf is

An LLM-first catalog of game modding operations, tools, knowledge, templates and skills. gmf identifies a game, selects a working toolchain and exposes every capability as a structured operation with a stable id, input and output schemas, declared effects and a gate. The same catalog is reachable four ways: the `gmf` command line, an MCP server (`gmf mcp`, one tool per operation and one prompt per skill), a Claude Code plugin with its own marketplace, and a Codex plugin with its marketplace file.

### Engines

- **Unity** (Mono and IL2CPP; BepInEx 5, BepInEx 6, MelonLoader 0.6+): detection with the Unity version, backend, IL2CPP metadata version, loader and store; loader setup; decompilation with ILSpy, Cpp2IL (`diffable-cs` and dummy assemblies) or Il2CppDumper; a normalized class dump; scaffolds with an example Harmony patch for every loader; build, deploy, validate (Harmony targets checked against the dump), remove and package (`Team-Mod-Version.zip`); asset extraction with AssetStudioModCLI and asset inspect and replace with a bundled UnityPy helper.
- **Unreal Engine 4 and 5** (UE4SS): detection of shipped layouts and the engine version from the executable; UE4SS install from the pinned `experimental-latest` release with the development or release console profile; Lua, C++ and pak scaffolds with feature and helper modules; a dump helper for object, usmap and header dumps and a normalized dump; deploy, validate, Lua checks, crash-stack reading, PE analysis and AOB signature emit and verify; asset mods on retoc, repak and UAssetGUI (extract, inspect as JSON, stage, pack to a `_P` pak or IoStore set, deploy to `Content/Paks/~mods`, remove), with AES-encrypted containers detected from their headers and opened with a key from the call, `GMF_AES_KEY` or the machine-local `gmf.local.json`; packaging.
- Games that are neither get engine family hints (Godot, GameMaker, Source, Ren'Py, RPG Maker, CryEngine, Frostbite, Construct, Unity WebGL) with the file that produced each hint.

### Workflow

- `gmf investigate` writes an evidence-backed profile without touching the game folder. `gmf plan draft|validate|apply` turns a goal into gated steps and runs them; `gmf verify` runs each step's check and records the result.
- Analysis operations (`analyze.classes`, `objects`, `entrypoints`, `references`, `assets`, `strings`) read the normalized dump, never game content.
- A workspace holds committed identity (`gmf.json`), machine paths (`gmf.local.json`), generated evidence (`gmf.profile.json`) and the active plan with its authorizations (`gmf.plan.json`); `gmf init` writes it with `AGENTS.md`, `CLAUDE.md`, `.gitignore` and `mods/`.
- 50 knowledge notes (core, Unity, Unreal, a per-game note format) and 24 skills, each labelled verified, observed or inferred and naming its origin.

### Safety

- Effects and gates: `read` and `workspaceWrite` run on their own; `gameWrite`, `toolInstall`, `network`, `launchGame`, `antiCheat` and `execute` need an authorization from the plan or the user's quoted instruction for every effect the operation declares (`toolInstall` covers `network`); `destructive`, `credentials` and `piracy` are hard gates. The executor enforces the gate before every handler.
- Every game write is backed up into the workspace first; multi-file writes roll back when one copy fails; restore accepts only recorded backups onto their own file.
- Tools are pinned by release tag, verified against the publisher's SHA-256, installed into a temporary folder and swapped in only on success; nothing is vendored.
- Corrupt JSON state is reported, never replaced. Path containment follows symlinks and treats a dangling link as outside. Processes that outlive their timeout fail.
- Hooks for Claude Code and Codex print the workspace at session start, block writes into the game folder and generated folders, and remind about an unvalidated mod; a pre-commit gate keeps game content, loader binaries and secrets out of the repository.

### Hosts

- Command line: `gmf catalog|games|detect|investigate|init|profile|plan|verify|run|setup|tool|knowledge|skill|package|status|doctor|hook|mcp|version`, every command with `--json`.
- MCP: stdio server speaking the handshake protocol versions through 2025-11-25; tools carry the operation schemas plus `workspace`, `authorized` and `authorizationSource`.
- Claude Code: `.claude-plugin/` manifest and marketplace with skills, agents, hooks and the MCP server. Codex: `.codex-plugin/` and `.agents/plugins/marketplace.json`.
