---
name: unreal.dumps.artifacts
title: Dump artifact catalog and targeted dumping
description: Every UE4SS game-derived artifact (object dump, CXX and UHT headers, usmap, jmap, static actors and meshes, UVTD, zMapGenBP) with its producer, purpose, config and the mod type that needs it, plus the dumping workflow and which dumps a mod goal requires.
engine: unreal
tags: [ue4ss, dumps, objectdump, usmap, jmap, headers, uht, uvtd, artifacts]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Dump artifact catalog and targeted dumping

What each game artifact is, what produces it and which artifacts a mod actually needs. Short overview: `unreal.dumps`. Further reading: RE-UE4SS `feature-overview/dumpers.md`, `feature-overview/sdk-generator.md` and `guides/generating-uht-compatible-headers.md`, https://github.com/UE4SS-RE/RE-UE4SS/tree/main/docs.

## The workflow

Artifacts come from a real UE4SS runtime attached to the running game. A first dump of a game goes through the skill `unreal-first-dump` (`unreal.gamedocs` describes the result); this note covers single artifacts.

1. **Deploy.** `gmf run unreal.deploy_dumper` copies the GmfDumper mod into the game's `Mods/` and merges the dumper keys into the game's real `UE4SS-settings.ini` (the dumper settings are a fragment to merge, never a replacement file).
2. **Run.** GmfDumper runs by itself once the game reaches its menu, or `unreal.run_dump` starts the game under a `launchGame` authorization. A user can also start the game and use the key bind or the `gmfdump` console command. The framework never stops the game.
3. **Collect.** `gmf run unreal.dump --input collect=true` copies the newest complete run into `dumps/unreal/runs/<run>/` and normalizes its object dump for the `analyze.*` operations. `unreal.verify_dump` checks the run against its manifest.

Never ask the human to run a dump you have no use for yet (targeted dumping, below).

## Native first

Scope: UE4SS's own dumpers only, not gameplay cheats (which avoid `CheatManager`; `unreal.cookbook.basic`). The Lua dump globals `DumpAllObjects()`, `DumpUSMAP(bool)`, `DumpJMAP(bool)`, `DumpStaticMeshes()` and `DumpAllActors()` **are** the native C++ dumpers, the same implementations the GUI buttons and default keybinds trigger. A Lua reimplementation could only call back into the same function. Never disable a built-in dumper.

| Artifact | Default keybind | GUI | Lua global | Settings section |
|---|---|---|---|---|
| Object dump (`UE4SS_ObjectDump.txt`) | Ctrl+J | Dumpers tab | `DumpAllObjects()` | `[ObjectDumper]` |
| C++ headers | Ctrl+H | none | (header generator) | `[CXXHeaderGenerator]` |
| UHT headers | Ctrl+Numpad9 | none | none | `[UHTHeaderGenerator]` |
| usmap | Ctrl+Numpad6 | Dumpers tab (+ "Include Blueprint-generated types") | `DumpUSMAP(bool)` | none |
| jmap | Ctrl+Numpad5 | Dumpers tab | `DumpJMAP(bool)` | none |
| static mesh / umap (`ue4ss_static_mesh_data.csv`) | Ctrl+Numpad7 | none | `DumpStaticMeshes()` | none |

Keybinds are configurable in `Mods/Keybinds/Scripts/main.lua`. The settings sections tune dumper behaviour (offsets, load-all-assets, header permissiveness); they do not enable or disable the action, which runs only when triggered. Prefer the native path for any single dump.

## GmfDumper

GmfDumper is a UE4SS mod with a Lua part and a C++ part (`unreal.gmfdumper.native`). It runs the UE4SS dumpers through their Lua globals and adds steps that need the C++ part: loading every asset, property values, Blueprint bytecode, class defaults and map loading as data. It never disables or replaces a built-in dumper.

**Starting a run.** With `auto_run.mode = "once"` (the default in `Mods/GmfDumper/config.lua`) it starts after the game has reached a stable map such as the main menu, holds player input, runs the `default_profile` (`full`), and closes the game. `mode = "always"` repeats on every start; `mode = "off"` leaves only the command and the key. `Mods/GmfDumper/auto_run_done.txt` marks a finished once-only run; delete it to run again. The console command is `gmfdump [full|quick|list|help|<step> ...]`: `full` loads every asset first, `quick` dumps only what is loaded now, `list` prints the step ids and whether each needs the C++ part, and one or more step ids run just those steps. The key bind in `config.lua` is `keybind`, Ctrl+`NUM_ZERO` by default.

**Run folder.** Each run writes `<ue4ss>/Dumps/<Game>-<engine>-<timestamp>/` (`output_root` in `config.lua`). `manifest.json` lists every step with its status and files; `run_complete.json` is written last, so a run without it did not end cleanly. `unreal.verify_dump` checks both. Folders by step id:

| Folder | Step ids and contents |
|---|---|
| `Objects` | `objects`: `UE4SS_ObjectDump.txt` |
| `Mappings` | `usmap`, `jmap`, `tmap`: `.usmap`, `.jmap`, `TMapOverrides.json` |
| `Headers`, `LuaTypes`, `SDK` | `cxx` (`Headers/CXX`), `uht` (`Headers/UHT`), `luatypes`, `bpsdk` (`SDK/UE4SS_SDK`) |
| `Reflection` | `reflection`; `class_defaults` (`class_defaults.jsonl`, full profile only) |
| `Scripts` | `scripts`: `bytecode.jsonl`, Blueprint bytecode |
| `World` | `world_actors` (`actors.csv`), `world_meshes` (`static_meshes.csv`), `world_json` (`actors.json`), `runtime` (`runtime.json`), `world_values` (`actor_values.jsonl`); the map tour writes `World/<MapName>` |
| `Levels` | `levels_loaded` and the level dump after the run: `Levels/<MapName>` with `actors.json` and `actor_values.jsonl`, listed in `Levels/levels.json` |
| `Assets` | `assets` (`asset_registry.json`), `asset_values` (`asset_values.jsonl`, full profile only), `containers` (`containers.json`, the files under `Content/Paks`) |
| `Names` | `names` (`fnames.csv`), `gameplay_tags` (`gameplay_tags.txt`) |
| `DataTables`, `DataAssets` | `datatables`, `data_assets` |
| `Config`, `UI` | `config_objects` (`config_objects.jsonl`), `widgets` (`widget_trees.json`) |
| `Hooks` | `hooks`: `ue4ss_hooks.json`, and `hookable_functions.json` with the C++ part |
| `Environment` | `environment`: copies of `UE4SS-settings.ini` and `UE4SS.log` |

The steps `load_assets` and `unload_assets` bracket the data steps and write no files. The map tour (`map_tour`, off by default) opens each map and runs the `World` steps again; some games crash on maps that are not meant to be opened without a session. Header generation and the SDK generator also have UE4SS defaults (CTRL+H, CTRL+Numpad 9; "Generate SDK" is a Dumpers tab button). A step that the build cannot run is marked skipped in the manifest with a reason. `disabled_steps` in `config.lua` leaves steps out.

**Settings fragment.** `UE4SS-settings.dumpers.ini` is merged into the game's `UE4SS-settings.ini` by `unreal.deploy_dumper` (`unreal.ue4ss.install`).

**Not included.** The engine's console variable list is not dumped, because UE4SS at the pinned build does not expose the console manager. `gamedocs/settings/` shows the variables the game's ini files set.

## Targeted dumping, the core rule

**Ask the mod goal before requesting any dump.** Every dump costs the human a relaunch and, for asset-loading dumps, real memory. Never run the full batch by default.

| Mod goal | Required | Optional or situational |
|---|---|---|
| Simple Lua console mod (cheats, tweaks, hooks on known classes) | object dump + CXXHeaderDump | UHT headers if the target class is not obvious from the object dump |
| Structured or feature Lua mod | object dump + CXXHeaderDump or UHTHeaderDump | jmap for reflection offsets UE4SS headers do not expose cleanly |
| C++ mod | UHT-compatible headers (for the mirror `.uproject`) | UVTD artifacts, only if header-derived layout proves insufficient (needs PDBs retail builds usually lack) |
| Asset or pak mod (unversioned properties) | `.usmap` + FModel/UAssetAPI `TMapOverrides.json` | jmap if converting via the `jmap` CLI is easier than the native usmap dumper |
| World or actor placement, `.umap` recreation | `DumpAllActors` + `DumpStaticMeshes` | `zMapGenBP` payload (only if rebuilding a `.umap` in-editor) |

If the goal spans categories, union the required dumps.

## Artifact catalog

### UE4SS_ObjectDump.txt

- **Producer:** Object Dumper, `DumpAllObjects()` (CTRL+J; GmfDumper step `objects`, `gmfdump objects`, into `Objects/`).
- **Purpose:** text dump of every loaded UObject (classes, functions, properties), each annotated with bracketed metadata (`n` name, `c` class, `or` outer, `o` property offset, more in the dumper doc's letter table). The baseline for what exists in the game.
- **Needed by:** all mod types as a first pass; the cheapest artifact, usually requested first.
- **Config:** `[ObjectDumper] LoadAllAssetsBeforeDumpingObjects` (default 0; force-load only if the dump looks incomplete, it is unstable and memory-heavy) and `UseModuleOffsets` (1 for reproducibility).

### CXXHeaderDump and UHTHeaderDump

Two distinct generators; do not confuse them.

- **CXXHeaderDump** (C++ Header Generator, CTRL+H): a `.hpp` per Blueprint plus base-class headers grouped by module, enums in separate `_enums` files. Quick, permissive visibility into signatures from Lua-side reasoning or ad-hoc C++ reference. It emits no UHT macros or correct `#include`s and its padding is not accurate. Needed by Lua mods, and as a cross-check when correcting UHT bitfields and padding.
- **UHTHeaderDump** (UHT Dumper, CTRL+Numpad 9): UHT-compatible headers to seed a mirror `.uproject` through the external `UE4GameProjectGenerator` commandlet. The real header source for a C++ mod project; Lua mods generally do not need it.
- **Config:** `[CXXHeaderGenerator] DumpOffsetsAndSizes` (1, for struct layout tooling) and `LoadAllAssetsBeforeGeneratingCXXHeaders` (0, same caveat); `[UHTHeaderGenerator] IgnoreAllCoreEngineModules` / `IgnoreEngineAndCoreUObject` (both 0 for full dumps) plus the `MakeAll*` and `MakeEnumClasses*` flags in `dumpers.md` that set how permissive the macros are.

### usmap (`.usmap`)

- **Producer:** `DumpUSMAP([bool IncludeBlueprintGenerated])` (CTRL+Numpad 6; GmfDumper step `usmap`, `gmfdump usmap`, into `Mappings/`; step `tmap` writes the matching `TMapOverrides.json` there). Original implementation credited to OutTheShade's UnrealMappingsDumper.
- **Purpose:** mapping data for **unversioned properties**, needed by asset tools (FModel, UAssetAPI, repak-adjacent tooling) to parse cooked assets whose property tags were stripped at cook. Includes Blueprint-generated classes, structs and enums by default (toggle in the Dumpers tab or `DumpUSMAP(false)`).
- **Needed by:** asset and pak mods; without a current usmap the tool cannot resolve unversioned properties.

### jmap (`.jmap`)

- **Producer:** `DumpJMAP([bool IncludeBlueprintGenerated])` (CTRL+Numpad 5; GmfDumper step `jmap`, `gmfdump jmap`, into `Mappings/`). Format by trumank.
- **Purpose:** full JSON reflection data: classes, functions, structs, enums (offsets, sizes, flags), class-default-object property values and approximate vtable layouts, written as `<GameName>-<EngineVersion>-<UE4SSCommitSHA>.jmap` in the UE4SS working directory. The `jmap` CLI converts it to `.usmap` or C++ headers; the `ue_binja` plugin applies it to Binary Ninja databases.
- **Needed by:** situational for all three mod types (conversion convenience for asset mods; vtable cross-checks for C++ and Lua). Request only when its data is actually needed.

### FModel / UAssetAPI TMapOverrides.json

- **Producer:** not a UE4SS dump; asset-tool configuration written by the GmfDumper step `tmap` (needs the C++ part) or by hand, pointing FModel and UAssetAPI at the current `.usmap` and any per-game type overrides.
- **Purpose:** makes the tool apply the right mapping when opening `.pak` and `.uasset` files; without it unversioned or ambiguous properties cannot be resolved even with a valid `.usmap` on disk.
- **Needed by:** asset and pak mods, always paired with a fresh `.usmap`; record both paths.

### Static actors and static mesh data

- **Producer:** `.umap` Recreation Dumper, `DumpAllActors()` and `DumpStaticMeshes()`, writing `ue4ss_static_mesh_data.csv` (CTRL+Numpad 7 combined; GmfDumper steps `world_actors` and `world_meshes`, `gmfdump world_actors world_meshes`, which keep the files as `World/actors.csv` and `World/static_meshes.csv`; step `world_json` adds `World/actors.json`).
- **Purpose:** dump all loaded actors so a `.umap` can be rebuilt in-editor. Two prerequisites: every dumped actor's static mesh, materials and textures must be reconstructed in the editor, and the `zMapGenBP.zip` payload must be installed per its Readme.
- **Needed by:** world and actor-placement and level-recreation mods; not ordinary Lua or C++ mods.

### vTableLayout / MemberVarLayout / UVTD_Configs (UVTD)

**Optional and advanced.** UVTD (UE4SS Virtual Table Dumper) produces vtable and member-variable layouts for C++ mods needing exact offsets.

- **Producer:** the external UVTD tool, not a GmfDumper step; it requires **PDB symbol files** for the target binary.
- **Purpose:** precise layout beyond header generation, for low-level vtable hooking or member access the SDK's `PlaceholderTypes.hpp` stand-ins cannot cover.
- **Needed by:** C++ mods only, and only when genuinely required. Most retail games ship no PDBs, so default to deriving layouts from the UHT and CXX header dumps and the generated SDK (the SDK generator is memory-accurate: it computes padding, alignment and bitfields from reflection data with no PDBs; see `sdk-generator.md`). Use UVTD only for an offset that cannot be recovered that way and where PDBs exist.

### MapGenBP (zMapGenBP)

- **Producer:** `zMapGenBP.zip`, a Blueprint payload released alongside UE4SS (RE-UE4SS Releases page); not generated by any dumper call.
- **Purpose:** the in-editor Blueprint tooling that consumes `ue4ss_static_mesh_data.csv` to rebuild a `.umap`; install it and follow its Readme.
- **Needed by:** world and actor-placement mods doing `.umap` recreation, paired with the static actor and mesh dump.

### Per-game working record

Not a UE4SS output: the accumulated per-game record the workspace keeps (engine version, dump paths, custom signature files from `unreal.aob.targets`), so work resumes across sessions without re-dumping. In gmf it is the workspace profile (`gmf.profile.json`) and `dumps/`. Distinct from the community `zCustomGameConfigs.zip` release asset; every binary is still analyzed fresh.
