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

**The framework does not launch the game.** Artifacts come from a real UE4SS runtime attached to the running game, a human-in-the-loop step.

1. **Prepare.** `gmf run unreal.dump` prepares the dump layout in the workspace and detects existing object, usmap and header dumps. Make sure the optional dumper helper mod and `shared/UEHelpers/` are deployed to the game's `Mods/`, and that the dumper keys are merged into the game's real `UE4SS-settings.ini` (the dumper settings are a fragment to merge, never a replacement file).
2. **Run (human).** Launch the game with UE4SS attached and trigger the dump by keybind, GUI or console command.
3. **Read back.** Read the helper's report (`GmfDumper_report.txt`, in the UE4SS folder) to see which dumps succeeded, locate the files and record their paths in the workspace profile. `unreal.dump` can normalize the object dump for the `analyze.*` operations.

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

## The optional GmfDumper helper

A thin wrapper over five built-in dump globals. It calls the same native functions, never disables or replaces them, and adds nothing to a single artifact's output. Its value is orchestration: batching dumps behind one command, a diagnostic report (engine and UE4SS version, per-dump OK or FAILED) and a scriptable trigger surface. One console command and one key bind, each dump `pcall`-guarded so one failure does not abort the rest:

| Console command | Keybind | Wraps | Produces |
|---|---|---|---|
| `gmfdump` or `gmfdump all` | F8 (`DumpKey` under `[GmfDumper]`) | all five, in order | everything below |
| `gmfdump objects` | none | `DumpAllObjects()` | `UE4SS_ObjectDump.txt` |
| `gmfdump actors` | none | `DumpAllActors()` | static actor data (feeds `.umap` recreation) |
| `gmfdump meshes` | none | `DumpStaticMeshes()` | `ue4ss_static_mesh_data.csv` |
| `gmfdump usmap` | none | `DumpUSMAP()` | `.usmap` |
| `gmfdump jmap` | none | `DumpJMAP()` | `.jmap` |

Every run rewrites `GmfDumper_report.txt` with the UE version, the UE4SS version and per-dump status; read it first. Header generation and the SDK generator are UE4SS defaults (CTRL+H, CTRL+Numpad 9; "Generate SDK" is a Dumpers tab button) and the helper does not wrap them; tell the human which keybind to press. The dumper settings fragment sets `UseModuleOffsets` under `[ObjectDumper]` for reproducible dumps across restarts, `HookProcessConsoleExec` under `[Hooks]` and `DumpKey` under `[GmfDumper]`.

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

- **Producer:** Object Dumper, `DumpAllObjects()` (CTRL+J; helper `gmfdump objects`).
- **Purpose:** text dump of every loaded UObject (classes, functions, properties), each annotated with bracketed metadata (`n` name, `c` class, `or` outer, `o` property offset, more in the dumper doc's letter table). The baseline for what exists in the game.
- **Needed by:** all mod types as a first pass; the cheapest artifact, usually requested first.
- **Config:** `[ObjectDumper] LoadAllAssetsBeforeDumpingObjects` (default 0; force-load only if the dump looks incomplete, it is unstable and memory-heavy) and `UseModuleOffsets` (1 for reproducibility).

### CXXHeaderDump and UHTHeaderDump

Two distinct generators; do not confuse them.

- **CXXHeaderDump** (C++ Header Generator, CTRL+H): a `.hpp` per Blueprint plus base-class headers grouped by module, enums in separate `_enums` files. Quick, permissive visibility into signatures from Lua-side reasoning or ad-hoc C++ reference. It emits no UHT macros or correct `#include`s and its padding is not accurate. Needed by Lua mods, and as a cross-check when correcting UHT bitfields and padding.
- **UHTHeaderDump** (UHT Dumper, CTRL+Numpad 9): UHT-compatible headers to seed a mirror `.uproject` through the external `UE4GameProjectGenerator` commandlet. The real header source for a C++ mod project; Lua mods generally do not need it.
- **Config:** `[CXXHeaderGenerator] DumpOffsetsAndSizes` (1, for struct layout tooling) and `LoadAllAssetsBeforeGeneratingCXXHeaders` (0, same caveat); `[UHTHeaderGenerator] IgnoreAllCoreEngineModules` / `IgnoreEngineAndCoreUObject` (both 0 for full dumps) plus the `MakeAll*` and `MakeEnumClasses*` flags in `dumpers.md` that set how permissive the macros are.

### usmap (`.usmap`)

- **Producer:** `DumpUSMAP([bool IncludeBlueprintGenerated])` (CTRL+Numpad 6; helper `gmfdump usmap`). Original implementation credited to OutTheShade's UnrealMappingsDumper.
- **Purpose:** mapping data for **unversioned properties**, needed by asset tools (FModel, UAssetAPI, repak-adjacent tooling) to parse cooked assets whose property tags were stripped at cook. Includes Blueprint-generated classes, structs and enums by default (toggle in the Dumpers tab or `DumpUSMAP(false)`).
- **Needed by:** asset and pak mods; without a current usmap the tool cannot resolve unversioned properties.

### jmap (`.jmap`)

- **Producer:** `DumpJMAP([bool IncludeBlueprintGenerated])` (CTRL+Numpad 5; helper `gmfdump jmap`). Format by trumank.
- **Purpose:** full JSON reflection data: classes, functions, structs, enums (offsets, sizes, flags), class-default-object property values and approximate vtable layouts, written as `<GameName>-<EngineVersion>-<UE4SSCommitSHA>.jmap` in the UE4SS working directory. The `jmap` CLI converts it to `.usmap` or C++ headers; the `ue_binja` plugin applies it to Binary Ninja databases.
- **Needed by:** situational for all three mod types (conversion convenience for asset mods; vtable cross-checks for C++ and Lua). Request only when its data is actually needed.

### FModel / UAssetAPI TMapOverrides.json

- **Producer:** not a UE4SS dump; external asset-tool configuration, hand- or script-authored, pointing FModel and UAssetAPI at the current `.usmap` and any per-game type overrides.
- **Purpose:** makes the tool apply the right mapping when opening `.pak` and `.uasset` files; without it unversioned or ambiguous properties cannot be resolved even with a valid `.usmap` on disk.
- **Needed by:** asset and pak mods, always paired with a fresh `.usmap`; record both paths.

### Static actors and static mesh data

- **Producer:** `.umap` Recreation Dumper, `DumpAllActors()` and `DumpStaticMeshes()`, writing `ue4ss_static_mesh_data.csv` (CTRL+Numpad 7 combined; helper `gmfdump actors` and `gmfdump meshes`).
- **Purpose:** dump all loaded actors so a `.umap` can be rebuilt in-editor. Two prerequisites: every dumped actor's static mesh, materials and textures must be reconstructed in the editor, and the `zMapGenBP.zip` payload must be installed per its Readme.
- **Needed by:** world and actor-placement and level-recreation mods; not ordinary Lua or C++ mods.

### vTableLayout / MemberVarLayout / UVTD_Configs (UVTD)

**Optional and advanced.** UVTD (UE4SS Virtual Table Dumper) produces vtable and member-variable layouts for C++ mods needing exact offsets.

- **Producer:** the external UVTD tool, not a helper-wrapped dumper; it requires **PDB symbol files** for the target binary.
- **Purpose:** precise layout beyond header generation, for low-level vtable hooking or member access the SDK's `PlaceholderTypes.hpp` stand-ins cannot cover.
- **Needed by:** C++ mods only, and only when genuinely required. Most retail games ship no PDBs, so default to deriving layouts from the UHT and CXX header dumps and the generated SDK (the SDK generator is memory-accurate: it computes padding, alignment and bitfields from reflection data with no PDBs; see `sdk-generator.md`). Use UVTD only for an offset that cannot be recovered that way and where PDBs exist.

### MapGenBP (zMapGenBP)

- **Producer:** `zMapGenBP.zip`, a Blueprint payload released alongside UE4SS (RE-UE4SS Releases page); not generated by any dumper call.
- **Purpose:** the in-editor Blueprint tooling that consumes `ue4ss_static_mesh_data.csv` to rebuild a `.umap`; install it and follow its Readme.
- **Needed by:** world and actor-placement mods doing `.umap` recreation, paired with the static actor and mesh dump.

### Per-game working record

Not a UE4SS output: the accumulated per-game record the workspace keeps (engine version, dump paths, custom signature files from `unreal.aob.targets`), so work resumes across sessions without re-dumping. In gmf it is the workspace profile (`gmf.profile.json`) and `dumps/`. Distinct from the community `zCustomGameConfigs.zip` release asset; every binary is still analyzed fresh.
