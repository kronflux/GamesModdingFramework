---
name: unreal.pak.blueprint
title: Blueprint and pak mods through BPModLoaderMod
description: When a task really needs the Blueprint and pak track, how BPModLoaderMod discovers, orders and mounts LogicMods paks, the ModActor convention, the BPML_GenericFunctions custom events, and how to cook, pack and deploy.
engine: unreal
tags: [ue4ss, pak, blueprint, bpmodloader, logicmods, repak, unrealpak, cook]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# UE4SS Blueprint and pak modding

The heaviest, most situational track. Default to Lua (`unreal.ue4ss.lua`) for anything expressible with hooks and reflection, and to C++ (`unreal.ue4ss.cpp`) for native performance or vtable access. Use this track only for real Blueprint content (new Actors, Widgets, materials, other `.uasset`s) that neither can construct. A Blueprint mod is authored inside the Unreal Editor (a build matching the game's engine version, recorded in the workspace profile), then cooked and packaged into a `.pak` outside the framework. This note covers the packaging and deploy mechanics and keeps the when-to-use gate honest; it cannot generate Blueprint content. Overview: `unreal.pak`.

The loader behaviour below records `BPModLoaderMod`'s own Lua, a built-in UE4SS mod, not a black box. Do not invent behaviour beyond it. Further reading: `BPModLoaderMod/Scripts/main.lua`, `BPModLoaderMod/load_order.txt`, `BPML_GenericFunctions/Scripts/main.lua` and `feature-overview/blueprint-modloader.md` in https://github.com/UE4SS-RE/RE-UE4SS. The pak mod scaffold (`gmf run unreal.scaffold`, type `pak-blueprint`) carries a README and packaging notes.

## When-to-use gate

Ask in order:

1. Can a Lua hook, `FindFirstOf`/`FindAllOf` or a UFunction call do it? Use the Lua track.
2. Does it need native performance or direct memory or vtable access? Use the C++ track.
3. Does it need a genuinely new Blueprint asset only the Editor can produce? This track, for that asset only. Keep surrounding logic in Lua or C++: a BP mod's only entry points are `PreBeginPlay` and `PostBeginPlay` on one spawned Actor, a much thinner lifecycle.

## How BPModLoaderMod discovers and mounts a Blueprint mod

`Mods/BPModLoaderMod/Scripts/main.lua`. Its `LoadModConfigs` runs once at startup:

1. Resolves `<Game>/Content/Paks/LogicMods/` through `IterateGameDirectories`, creating it with `CreateLogicModsDirectory()` if missing. This **`LogicMods/`** folder, not a Lua mod's `Mods/<ModName>/`, is the deploy target for a packaged `.pak`.
2. Iterates every entry under `LogicMods/`. For each subfolder with a `config.lua`, it `dofile`s it and expects a `Mods[<FolderName>]` table with at least `AssetName` (optionally overriding `AssetPath`).
3. Walks every file in `LogicMods/` (including subfolders) and for each `*.pak` whose name without extension has no config from step 2, builds a **default config**: `AssetName = "ModActor"` (resolved through `UEHelpers.FindOrAddFName`) and `AssetPath = "/Game/Mods/<ModNameNoExtension>/ModActor"`. So the mod's name to the loader is **the pak filename minus `.pak`**: that string goes in `load_order.txt` and, absent a `config.lua` override, is the path component of the expected asset. The convention is a Blueprint **Actor** literally named `ModActor` (compiled class `ModActor_C`).
4. Reads `Mods/BPModLoaderMod/load_order.txt`: one mod name per line, `;` starts a comment, top-to-bottom sets priority. Unlisted mods still load, later and unordered. An empty or missing file logs `"...loading all BP mods in random order."`.
5. At load time (`LoadMods`, called from `RegisterLoadMapPostHook`, from the initial `ExecuteInGameThread` check for an already-running world and manually via the `INS` keybind for hot reload) it caches `AssetRegistryHelpers`/`AssetRegistry`; for each ordered mod it resolves the Blueprint class through the `AssetRegistry` from `AssetPath`/`AssetName` (`ObjectPath` form before UE 5.1, `PackageName` + `AssetName` from 5.1), `World:SpawnActor`s it and, if valid, calls `PreBeginPlay()` directly. `PostBeginPlay` is not called directly: `RegisterBeginPlayPostHook` watches every actor's begin-play and calls the Blueprint's own `PostBeginPlay` when the spawned actor's class matches. **`PreBeginPlay` and `PostBeginPlay` on the `ModActor` graph are the entire lifecycle a BP mod gets.**

## The `BPML_GenericFunctions` shared dependency

Blueprint graphs cannot call arbitrary Lua. UE4SS bridges this with **Custom Events** registered from Lua via `RegisterCustomEvent`, which a Blueprint invokes as an ordinary node. `BPML_GenericFunctions` (`Mods/BPML_GenericFunctions/Scripts/main.lua`) is a separate built-in Lua mod, not deployed into `LogicMods/`, registering shared events every BP mod can use:

- **`PrintToModLoader(Message: FString)`**: logs `Message` tagged with the calling mod's name (the caller's `GetClass():GetFullName()` split on `/`, second-to-last segment). Type-checks `Message` as an `FString`.
- **`ConstructPersistentObject(Class: UClass) -> UObject`**: constructs a `UObject` parented to the current `GameInstance` with `GarbageCollectionKeepFlags` so it survives level transitions, which a Blueprint alone cannot easily arrange. Validates `Class` is a real `UClass` or derivative.

If a mod uses either Custom Event, the install needs `BPML_GenericFunctions` present and enabled beside `BPModLoaderMod`. Both ship with UE4SS, so document it as a runtime prerequisite for end users; it is not bundled in the `.pak`.

## Authoring, cooking and packaging

1. **Author in the Editor** at the game's exact engine version. Create a Blueprint **Actor** named `ModActor` at `/Game/Mods/<ModName>/ModActor` (or another `AssetName`/`AssetPath` with a `config.lua` override). Implement logic on `PreBeginPlay` and `PostBeginPlay`; add Custom Event nodes for `PrintToModLoader` or `ConstructPersistentObject` as needed.
2. **Cook** for the target platform: `UnrealEditor-Cmd.exe <Project>.uproject -run=Cook -TargetPlatform=WindowsNoEditor -CookDir=/Game/Mods/<ModName>` (or the Editor's package UI; flags vary by engine version).
3. **Pack** the cooked output: `UnrealPak.exe <ModName>.pak -create=<CookedContentDir> -compress`. Internal paths must mirror `/Game/...` so the AssetRegistry lookup resolves. Without a matching Editor toolchain, `repak` (https://github.com/trumank/repak) packs already-cooked `.uasset` and `.uexp`: `repak pack <CookedContentDir> <ModName>.pak`. `gmf run unreal.package` builds a pak with repak when the project asks for one.
4. **Name for mount priority.** The loader only cares about the filename minus `.pak`. If the game's pak mounting uses a priority suffix (many use `_P`, such as `<ModName>_P.pak`, to mount after base paks so content overrides stock assets), follow it and use the **full** filename minus `.pak`, suffix included, in `load_order.txt`; the loader matches the literal filename.
5. **Deploy** the `.pak` to `<Game>/Content/Paks/LogicMods/` (created on first run if missing) with `gmf run unreal.deploy` (type `pak`), a soft-gated game write. If order matters, add the name to `Mods/BPModLoaderMod/load_order.txt` on the install. Verify in the UE4SS log: `[BPModLoaderMod]` lines naming the mod during the config scan and load passes.

Note from `unreal.mined-gotchas`: assets packaged as IoStore (`.ucas`/`.utoc`) could not be mounted by one game's UE4SS mod; treat pak mounting as game-specific.
