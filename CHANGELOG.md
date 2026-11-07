# Changelog

## 0.4.0

First public release.

### What gmf is

An LLM-first catalog of game modding operations, tools, knowledge, templates and skills. gmf identifies a game, selects a working toolchain and exposes every capability as a structured operation with a stable id, input and output schemas, declared effects and a gate. The same catalog is reachable four ways: the `gmf` command line, an MCP server (`gmf mcp`, one tool per operation and one prompt per skill), a Claude Code plugin with its own marketplace, and a Codex plugin with its marketplace file.

### Engines

- **Unity** (Mono and IL2CPP; BepInEx 5, BepInEx 6, MelonLoader 0.6+): detection with the Unity version, backend, IL2CPP metadata version, loader and store; loader setup; decompilation with ILSpy, Cpp2IL (`diffable-cs` and dummy assemblies) or Il2CppDumper; a normalized class dump; scaffolds with an example Harmony patch for every loader; build, deploy, validate (Harmony targets checked against the dump), remove and package (`Team-Mod-Version.zip`); asset extraction with AssetStudioModCLI and asset inspect and replace with a bundled UnityPy helper.
- **Unreal Engine 4 and 5** (UE4SS): detection of shipped layouts and the engine version from the executable; UE4SS install from the pinned `experimental-latest` release with the development or release console profile; Lua, C++ and pak scaffolds with feature and helper modules; a dump helper for object, usmap and header dumps and a normalized dump; deploy, validate, Lua checks, crash-stack reading, PE analysis and AOB signature emit and verify; asset mods on retoc, repak and UAssetGUI (extract, inspect as JSON, stage, pack to a `_P` pak or IoStore set, deploy to `Content/Paks/~mods`, remove); packaging.
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
