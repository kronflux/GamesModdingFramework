---
name: unity.melonloader
title: MelonLoader mod loader layout
description: Recognize a MelonLoader install and place a Melon mod or an IL2CPP assembly where the loader expects it.
engine: unity
tags: [melonloader, loader, mono, il2cpp, mods]
confidence: verified
sources: [MelonLoader documentation, MelonLoader GitHub repository, earlier Unity modding framework notes]
---

# MelonLoader mod loader layout

## Recognizable files

A MelonLoader install has a `MelonLoader/` folder next to the game executable
and usually `version.dll` or `dobby.dll` as the proxy. In 0.6 and later,
`MelonLoader/net6/` (IL2CPP) or `MelonLoader/net35/` and `MelonLoader/net472/`
(Mono) hold `MelonLoader.dll` and `0Harmony.dll`; `net6/` also holds
`Il2CppInterop.Runtime.dll` (verified in the v0.7.3 release zip, 2026-11-07). The loader also creates a `Mods/`
folder and a `UserData/` folder.

For an IL2CPP game, MelonLoader generates assemblies under
`MelonLoader/Il2CppAssemblies/` on first launch. An empty folder before that
launch is expected.

A bootstrap-only install has the loader files but no `MelonLoader/` runtime
folder. Record the missing part and a remediation instead of treating the loader
as working.

## Mod layout

- Mono mod: `Mods/<Name>.dll` with a `MelonMod` subclass.
- IL2CPP mod: the same file, but the project references the generated
  assemblies from `MelonLoader/Il2CppAssemblies/`.
- Configuration: `UserData/MelonPreferences.cfg`.

## Detection notes

- `MelonLoader/` present with `version.dll` is the usual layout.
- MelonLoader replaces BepInEx; having both installed is a conflict. Report it
  and ask which loader the user wants.
- The loader version is read from `MelonLoader.dll` in `MelonLoader/net6/`,
  `net35/` or `net472/` (0.6 and later) or in `MelonLoader/` (0.5).

## Pitfalls

- Do not create IL2CPP assemblies yourself. Launch the game once, then detect
  the populated folder.
- A Melon mod built against the wrong runtime (net35 versus net6) fails to load
  without a clear log line. Check the game's Unity version first.

## Mod development

MelonLoader is a universal Unity loader: it detects the Mono or IL2CPP backend and, for IL2CPP games, boots a .NET (CoreCLR) runtime.

**Which loader.** Use the loader already installed in the game (`gmf run game.detect`); the game's modding community decides it, since mods for different loaders do not load together without bridges. Mono game: BepInEx 5 (`unity.bepinex.lifecycle`) or MelonLoader. IL2CPP game: MelonLoader or BepInEx 6 (`unity.il2cpp.patching`); BepInEx 5 cannot load IL2CPP games. `gmf run unity.scaffold` with loader `melonloader` renders `Mod.cs` (a `MelonMod` that logs from `OnInitializeMelon`) for either backend.

**Mods folder.** `<game-dir>/Mods/`, plus `Plugins/`, `UserData/` and `UserLibs/` beside it. Some setups differ; `MelonLoader/Latest.log` lists what was loaded.

**Mod structure.** A .NET class library referencing `MelonLoader.dll`; the entry class extends `MelonMod` and the assembly carries `[MelonInfo]` and `[MelonGame]`:

```csharp
using MelonLoader;

// Signature: (Type, Name, Version, Author[, DownloadLink]), Version BEFORE Author
[assembly: MelonInfo(typeof(MyMod.MyModCore), "My Mod", "1.0.0", "Author")]
[assembly: MelonGame()] // empty = all games; or ("Studio", "Game Name") to target one

namespace MyMod {
    public class MyModCore : MelonMod {
        public override void OnInitializeMelon() { /* startup */ }
        public override void OnUpdate() { /* per-frame */ }
        public override void OnSceneWasLoaded(int buildIndex, string sceneName) { }
    }
}
```

Lifecycle callbacks: `OnInitializeMelon`, `OnLateInitializeMelon`, `OnUpdate`, `OnLateUpdate`, `OnFixedUpdate`, `OnGUI`, `OnSceneWasLoaded` and `OnSceneWasUnloaded`, `OnApplicationQuit`. The legacy `OnApplicationStart` exists; prefer `OnInitializeMelon`.

**IL2CPP specifics.** Target `net6.0` (CoreCLR). After installing MelonLoader and launching once, interop assemblies are generated: MelonLoader 0.6.0 and later in `MelonLoader/Il2CppAssemblies/` with `Il2Cpp`-prefixed game proxies (`Il2CppAssembly-CSharp.dll`); 0.5.x in `MelonLoader/Managed/`. Reference those (not the game's real DLLs; `<Game>_Data/Managed/` does not exist for IL2CPP) plus `Il2Cppmscorlib.dll`, `Il2CppInterop.Common.dll` and `Il2CppInterop.Runtime.dll`. Use interop types like normal C# types. Do not ship `UnhollowerBaseLib.dll`: 0.6 and later bundle Il2CppInterop and a stray old copy gives "Could not load file or assembly". Details: `unity.csharp.patterns`.

**Harmony.** MelonLoader bundles HarmonyX; use the `HarmonyLib` namespace (0.4.0 and later; `Harmony` on 0.3.0 and older). **Do not call `PatchAll()` yourself:** unlike BepInEx, MelonLoader applies the `[HarmonyPatch]` classes in your assembly automatically, and `new Harmony(...).PatchAll()` in `OnInitializeMelon` patches everything twice. Use `HarmonyInstance` (the property on `MelonMod`) for manual `Patch` calls, and `[assembly: HarmonyDontPatchAll]` to opt out for full control of order or conditions. IL2CPP constraints (Prefix and Postfix only): `unity.il2cpp.patching`.

**Logging and config.** `LoggerInstance.Msg`, `.Warning`, `.Error`. `MelonPreferences.CreateCategory("ModName")` then `category.CreateEntry("Key", defaultValue, description: "...")`; values persist in `UserData/MelonPreferences.cfg` (TOML).

**Prerequisites.** The .NET SDK to build, `MelonLoader.dll` plus generated interop assemblies to reference, and the loader installed in the target game.
