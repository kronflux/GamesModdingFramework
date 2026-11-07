---
name: unity.il2cpp.interop
title: IL2CPP interop assemblies
description: Generate and use interop assemblies so a C# mod can reference IL2CPP classes without touching the shipped binary.
engine: unity
tags: [il2cpp, interop, bepinex6, melonloader, cpp2il]
confidence: verified
sources: [BepInEx 6 Il2CppInterop documentation, Cpp2IL GitHub repository, MelonLoader documentation, earlier Unity modding framework notes, Cpp2IL 2022.1.0-pre-release.21 release notes, BepInEx issue 1342, Il2CppInterop issue 283, Il2CppDumper README, a Unity 6000.3.14 IL2CPP title verified 2026-11-07]
---

# IL2CPP interop assemblies

Patching rules, interop types and triage are in `unity.il2cpp.patching`; C# compatibility is in `unity.csharp.patterns`.

An IL2CPP game ships no managed assemblies. `GameAssembly.dll` contains native
code and `global-metadata.dat` contains the metadata. A C# mod needs generated
managed wrappers, called interop assemblies, to reference game types.

## How the wrappers appear

- BepInEx 6 runs Il2CppInterop on the first launch and writes the wrappers under
  `BepInEx/interop/`. The wrappers are regenerated on first launch after the
  game updates, so a stale folder is a normal intermediate state.
- MelonLoader writes wrappers under `MelonLoader/Il2CppAssemblies/` on first
  launch.
- Cpp2IL can produce a dump and assemblies directly, which is useful for static
  analysis without launching the game.

## Unity 6 and the metadata version

The first four bytes of `global-metadata.dat` are the magic `0xFAB11BAF`; the next four are the metadata version, which `gmf investigate` records as `runtime.metadataVersion`. The version, not the Unity version, decides which tools can read a game.

- **Verified** on one Unity 6000.3.14f1 game: metadata version 39.
- **Verified** there: Cpp2IL `2022.1.0-pre-release.21` reads v39 (its release notes add versions 35, 38, 39 and 104-106, up to the 6000.5 alpha). gmf pins that build; the older stable Cpp2IL releases do not read Unity 6 games, and Il2CppDumper stops near v31.
- **Verified** there: BepInEx 6 bleeding-edge build 793 generated the interop assemblies on first launch. **Observed** in BepInEx issue 1342: builds 755 and newer read v39; 754 and older fail with "We support 23-31, got 39". Stable BepInEx 5 has no IL2CPP support.
- Call Cpp2IL 2022.1 with `--output-as diffable-cs` (C# that `unity.normalize_dump` reads, with `//Field offset: 0x..` comments) or `--output-as dummydll`, and `--output-to <dir>`. There is no `--output-root` option.
- Call Il2CppDumper with three positional arguments, `Il2CppDumper.exe <executable-file> <global-metadata> <output-directory>`: for a Windows build the executable is `GameAssembly.dll` and the metadata is `<Game>_Data/il2cpp_data/Metadata/global-metadata.dat`. It has no `--game-path` or `--output-dir` flags. `unity.decompile` writes its output (`dump.cs`, `DummyDll/`) to `decompiled/unity/il2cpp/Il2CppDumper/`. Its `config.json` option `RequireAnyKey` makes it wait for a key press at the end; set it to `false` for unattended runs. Source: the Il2CppDumper README (github.com/Perfare/Il2CppDumper).
- **Observed** on Unity 6000.x: BepInEx logs `Class::Init signatures have been exhausted, using a substitute!`. Il2CppInterop issue 283 reports a crash about 15 seconds after "Chainloader startup complete" on a Unity 6000.3.15 game with build 788. On a Unity 6000.3.14 game with build 793 the same warning appeared and the game ran a match without crashing, with no plugins loaded. **Verified** on the same game afterwards: a plugin with Harmony prefixes on game methods loaded and worked with the warning present. **Unverified:** whether a plugin that injects its own IL2CPP classes is affected. Read `BepInEx/LogOutput.log` after the first plugin load.
- Interop unstripping is partial on Unity 6: on one Unity 6000.3 game 20,957 methods were restored and 1,959 were not, so a target method can lack a callable wrapper. Check the interop assembly before planning a patch around a method.

## Workflow

1. Detect the backend as `il2cpp` and record the loader flavour.
2. If the interop folder is empty, record an unknown and the remediation: launch
   the game once with the loader installed.
3. Decompile or dump the interop assemblies with `unity.decompile`.
4. Build the mod against the generated assemblies, not against
   `GameAssembly.dll`.
5. Validate the Harmony targets against the same interop version.

## Pitfalls

- Do not copy interop assemblies into the repository. They contain game code and
  metadata.
- An interop folder from a previous game version resolves types to the wrong
  addresses. Regenerate it after every game update.
- Obfuscated metadata produces unreadable names. Use strings and method
  signatures to identify a target, then record the evidence.
