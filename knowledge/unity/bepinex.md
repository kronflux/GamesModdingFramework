---
name: unity.bepinex
title: BepInEx loader and plugin layout
description: Recognize a BepInEx 5 or BepInEx 6 install from its files and place a plugin under the right plugins folder.
engine: unity
tags: [bepinex, loader, mono, il2cpp, plugins]
confidence: verified
sources: [BepInEx documentation, BepInEx GitHub repository, earlier Unity modding framework notes]
---

# BepInEx loader and plugin layout

Plugin attributes, lifecycle order, configuration and debug patterns are in `unity.bepinex.lifecycle`.

## Recognizable files

A BepInEx 5 install has `winhttp.dll` (the doorstop proxy), `doorstop_config.ini`,
`BepInEx/core/BepInEx.dll` and a `BepInEx/plugins/` folder.

A BepInEx 6 install adds `BepInEx/core/BepInEx.Unity.IL2CPP.dll` for IL2CPP games
or `BepInEx.Unity.Mono.dll` for Mono games. The loader entry may be
`winhttp.dll` with a `doorstop_config.ini` that names the core CLR assembly.

A BepInEx 6 IL2CPP install also has `BepInEx/interop/`. The folder is populated
by Il2CppInterop on the first launch. An empty folder is expected before that
launch, not a broken install.

## Which build

For IL2CPP games use BepInEx 6 from the bleeding-edge build server (`gmf run unity.setup_loader --input loader=bepinex6-il2cpp`), not a numbered release; Unity 6 games need build 755 or newer (`unity.il2cpp.interop`). The server publishes no checksum, so gmf records the SHA-256 it downloaded. The detected version comes from the first line of `BepInEx/LogOutput.log`, so it is known only after one launch.

## Plugin layout

- Plugin assembly: `BepInEx/plugins/<Name>/<Name>.dll`.
- Configuration: `BepInEx/config/<guid>.cfg`.
- Logs: `BepInEx/LogOutput.log`.
- A plugin declares `BepInPlugin(guid, name, version)` and usually
  `BepInProcess` to limit the target executable.

## Detection notes

- `BepInEx/core` missing while `winhttp.dll` exists means a partial install.
  Record the missing path and a remediation, do not claim the loader works.
- BepInEx 5 does not support IL2CPP. An IL2CPP game needs BepInEx 6 or
  MelonLoader.
- The loader version comes from the file version of the core assembly, not from
  the folder name.

## Pitfalls

- Copying plugins into the game folder without a backup overwrites files. Use
  `unity.deploy`, which backs up before writing.
- A `BepInEx/plugins` folder inside the workspace is not the game's folder.
  Check the profile `paths.deploy` value.
