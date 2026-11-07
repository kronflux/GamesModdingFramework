# Workflows

## Find and investigate

```bash
gmf games --json
gmf investigate --game "C:/Games/Some Game" --workspace "C:/mods/SomeGame" --json
```

`gmf games` lists games under `GMF_GAME_ROOTS` and the workspace game path; when neither is set, or with `--input includeSteam=true`, it also lists the Steam libraries it finds. The profile records the engine, version, architecture, backend, loader, tools, capabilities, markers, paths, evidence and unknowns. It never writes inside the game folder. If the engine is unknown, the profile lists what was checked, the engine family hints it found and the next probes; select an engine manually before scaffolding.

## Plan

```bash
gmf plan draft --goal "Add a configurable flashlight"
gmf plan validate
gmf plan apply --authorized gameWrite --source "user: deploy the flashlight mod"
gmf verify
```

The draft is written to `gmf.plan.json`. The LLM edits it, then `gmf plan validate` reports every missing operation, input, tool, effect or gate. `gmf plan apply` runs the steps and stops at the first failure unless a step is optional. `gmf verify` runs each step's `verify` command that starts with `gmf`, records a manual check as such, and stores the results under `verification` in the plan.

A step looks like this:

```json
{
  "id": "1",
  "operation": "unity.decompile",
  "inputs": { "gameDir": "C:/Games/Some Game", "backend": "il2cpp" },
  "why": "Find the player controller and the light component.",
  "effects": ["read", "workspaceWrite"],
  "gate": "auto",
  "expect": "Decompiled assemblies under decompiled/ and dumps/unity-il2cpp.json",
  "verify": "gmf run analyze.classes --input profile=gmf.profile.json --input query=PlayerController"
}
```

## Unity

1. `unity.decompile`: ILSpy for Mono, Cpp2IL or Il2CppDumper for IL2CPP. It also writes `dumps/unity-<backend>.json`; `unity.normalize_dump` rebuilds it from an existing decompile.
2. `analyze.classes`, `analyze.entrypoints`, `analyze.references`, `analyze.strings` over the normalized dump.
3. `unity.scaffold`: BepInEx 5, BepInEx 6 Mono, BepInEx 6 IL2CPP or MelonLoader, with an example Harmony patch under `Patches/`.
4. `unity.build`, `unity.deploy`, `unity.validate`, `unity.package`.
5. `unity.extract_assets`, `unity.inspect_asset`, `unity.replace_asset` for content work.

The loader and backend are independent. Detect the loader from the game folder; never infer it from the backend.

## Unreal

1. `unreal.setup_ue4ss` with a soft-gate authorization.
2. `unreal.dump` prepares the dump layout and collects existing artifacts. With `deployHelper=true` it deploys the GmfDumper mod under a `gameWrite` gate (`unreal.deploy_dumper`), which runs the native UE4SS dumpers from one console command or key. With `collect=true` it copies the object dump, usmap, headers and report into `dumps/` and writes `dumps/unreal-objects.json`.
3. `analyze.objects`, `analyze.classes`, `analyze.entrypoints` over the normalized dump.
4. `unreal.scaffold` for Lua (minimal or structured, with `features` and `helpers`), C++ or pak.
5. `unreal.lua_check` after every Lua edit; `unreal.build` for C++.
6. `unreal.deploy`, `unreal.validate`, `unreal.package`.
7. `unreal.crash_stack` on a UE4SS crash log; `unreal.pe_analyze`, `unreal.aob_emit` and `unreal.aob_verify` when reflection does not expose a target.
8. `unreal.extract_assets`, `unreal.inspect_asset`, `unreal.stage_asset`, `unreal.pack_mod`, then `unreal.deploy --input type=pak`.

The UE version may be unknown until the game runs with UE4SS or a PatternSleuth log is read. Do not guess it.

## Debug

A build or validation failure returns the exact command, exit code and log tail. Reproduce it with `generic.run_tool`, read the first error, search the knowledge base, and change one thing. Compare a deployed file with its build output with `generic.hash`.

## Safety

- No game content, decompiled code, loader binaries or extracted assets are committed. The workspace `.gitignore` and the pre-write hook cover a mod workspace.
- A soft gate is overridable when the plan or your instruction authorizes it; the source is recorded. An unsatisfied soft gate returns `GMF-E-GATE-001`.
- A hard gate needs your explicit approval. Piracy and credential access are refused.
- Anti-cheat markers produce a warning and knowledge links, not a block. Check the ban risk before using a mod online.
