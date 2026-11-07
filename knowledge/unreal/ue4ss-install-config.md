---
name: unreal.ue4ss.install
title: UE4SS install, settings and enabling mods
description: Where UE4SS goes beside the shipping binary, dev versus release builds, the UE4SS-settings.ini sections that matter, merging the dumper settings, mods.txt versus enabled.txt, and how to verify it is running.
engine: unreal
tags: [ue4ss, install, settings, mods-txt, enabled-txt, dev-build, ini]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# UE4SS install and config

Getting UE4SS physically installed and configured, and enabling or disabling mods. Not about diagnosing a broken install (`unreal.debugging`) or writing mod code (`unreal.ue4ss.lua`, `unreal.ue4ss.cpp`).

## Root directory versus working directory

RE-UE4SS's docs define these; the distinction explains why a file lives where it does:

- **root directory**: the UE4SS DLL (`ue4ss.dll` / `UE4SS.dll`) and the proxy DLL (`dwmapi.dll`, or whichever name the engine loads).
- **working directory**: `UE4SS-settings.ini`, `UE4SS.log` and `Mods/` (mod folders and `mods.txt`); inside the root directory.
- **game directory**: the top-level install folder (often a launcher wrapper).
- **game executable directory**: where the real executable lives, `<GameInternalName>/Binaries/Win64/`.

For the "Basic" and "Developer" install methods, all of root, working and game executable directory collapse to `<GameInternalName>/Binaries/Win64/`. A "Central Install Location" method (root outside any game, one working directory per game) exists but is not used here; do not assume it unless someone set it up.

## Install location

Extract UE4SS **beside the shipping binary**, `<GameInternalName>/Binaries/Win64/`, where `dwmapi.dll` (the proxy loader) and `ue4ss/UE4SS.dll` sit so the game process loads the proxy. `<GameInternalName>` is the path segment before `Binaries/Win64` (for `...\FactoryGame\Binaries\Win64\FactoryGame-Win64-Shipping.exe` it is `FactoryGame`). UE4SS injects the next time the game's executable (the wrapper, not necessarily the shipping exe) is launched; this method needs no manual injection.

## Which release: experimental-latest, not the versioned release

**Verified** against the GitHub release list on 2026-11-07: most modern games need the rolling **experimental-latest** build, not a numbered release such as v3.0.1. The numbered releases predate structural changes in UE4SS and lack support for recent engines; Unreal Engine 5.6 support exists only in the experimental line.

- The release page anchor is `https://github.com/UE4SS-RE/RE-UE4SS/releases/#release-experimental-latest`; the API path is `/repos/UE4SS-RE/RE-UE4SS/releases/tags/experimental-latest`.
- Do not take "the newest release" from the release list. The list is ordered by creation date, and on 2026-11-07 its first entry was a different prerelease (`experimental2`), while the rolling `experimental-latest` tag was created in 2024 and keeps receiving new assets.
- The regular asset is `UE4SS_v<version>-<commits>-g<hash>.zip`; `zDEV-UE4SS_...zip` is the developer build (see below). Each asset carries a published SHA-256 digest; `gmf run unreal.setup_ue4ss` verifies the archive against it before extracting.
- A 3.x archive holds `dwmapi.dll` beside a `ue4ss/` folder. Both go directly into `<GameInternalName>/Binaries/Win64/`; `dwmapi.dll` inside `ue4ss/` never loads.
- Read the engine version first (`gmf detect` reads it from the shipping exe's version resource). For UE 5.4 and newer, assume experimental-latest is required.

## Dev (zDEV) versus release build

RE-UE4SS ships two channels per version:

- **`zDEV-UE4SS_v{version}.zip`** (dev): debug console, GUI console (Live View, object browser) and full dumpers on by default. Install while developing or dumping; you need the console and dumpers to see load errors and run dumps.
- **`UE4SS_v{version}.zip`** (release or basic): quieter defaults, no extra windows, for end users running finished mods.

The installer resolves the regular asset from the RE-UE4SS `experimental-latest` GitHub release by the anchored pattern `^UE4SS_v[^/]*\.zip$`, never a hardcoded versioned name, because that release tag is retagged in place on every build. It does not install the `zDEV-` build; `unreal.ue4ss_settings` turns on the console keys that build enables by default.

## Bootstrapping

`gmf run unreal.setup_ue4ss` (inputs `gameDir`, `channel`, which accepts only `experimental-latest`, and `development`) installs UE4SS from the tool registry into the game folder behind a soft gate. Procedure:

1. Locate the game's `Binaries/Win64` folder.
2. Download the asset registered for `ue4ss` into the tool cache and verify its published SHA-256 digest.
3. Copy the archive contents into `Binaries/Win64` beside the shipping exe, backing up every file it overwrites, and create `ue4ss/Mods`.
4. Apply the development settings profile unless `development=false`.

The operation returns the version, path, channel and verification result as evidence. Running it again copies over the existing files with backups. **It does not launch the game.** Confirming UE4SS loads (console appears, log has fresh timestamps, dumpers run) is a manual human step; see `unreal.debugging` if it fails.

## `UE4SS-settings.ini`

In the working directory beside `ue4ss.dll` (here `<GameInternalName>/Binaries/Win64/UE4SS-settings.ini`). Relevant sections:

- `[Overrides]`: `ModsFolderPath`, `+ModsFolderPaths`/`-ModsFolderPaths`, and `ControllingModsTxt` (one authoritative `mods.txt` for load order across several mod directories instead of merging each one's own).
- `[General]`: hot reload (`EnableHotReloadSystem`, `HotReloadKey`, `EnableAutoReloadingLuaMods`), AOB scan cache and behaviour (`UseCache`, `InvalidateCacheIfDLLDiffers`, `DoEarlyScan`, `SecondsToScanBeforeGivingUp`) and `GUObjectArray` iteration knobs for startup-crash troubleshooting (`bUseUObjectArrayCache`, `bForceGUObjectArrayForIteration`). Also the hook switches that gate Lua features: `HookProcessConsoleExec` (console commands, `unreal.field-notes` 2), `HookUObjectProcessEvent`, `HookEngineTick`, and the game-thread default `DefaultExecuteInGameThreadMethod` (note 1).
- `[EngineVersionOverride]`: pin `MajorVersion`, `MinorVersion`, `DebugBuild` when auto-detection fails.
- `[ObjectDumper]`, `[CXXHeaderGenerator]`, `[UHTHeaderGenerator]`: dump flags (`unreal.dumps.artifacts`).
- `[Debug]`: `ConsoleEnabled`, `GuiConsoleEnabled`, `GuiConsoleVisible`, `ToggleGuiKey`; they let you see the console or Live View to confirm UE4SS runs. The regular experimental build ships all three as `0` (verified 2026-11-07); see "Development settings" below.
- `[SDKGenerator]`: `OutputPath` for generated SDK files (empty means `Binaries/Win64/UE4SS_SDK`).

### Development settings

While developing a mod, set the UE4SS debug console on and visible, so script errors, prints and dumps are seen as they happen instead of only in `UE4SS.log`:

```ini
[Debug]
; Whether to enable the external UE4SS debug console.
ConsoleEnabled = 1
GuiConsoleEnabled = 1
GuiConsoleVisible = 1
```

`gmf run unreal.setup_ue4ss` applies this development profile after it installs UE4SS (pass `--input development=false` to skip it). On an existing install run `gmf run unreal.ue4ss_settings --input profile=development`; it is a game write, needs a `gameWrite` authorization, and backs up the ini first. Before handing a game back for normal play, `--input profile=release` turns the three keys off. Keep the default `GraphicsAPI = opengl`; **observed** on one UE 5.6 game, the GUI console with OpenGL crashed the game at startup and `GraphicsAPI = dx11` fixed it. Change the backend only for a game that shows that crash, and record it in that game's note under `knowledge/games/`. The keys live in the game's `UE4SS-settings.ini`, not in a mod, so a packaged mod is not affected.

### Applying the dumper settings

The dumper settings are a documented **fragment**, not a full settings file. It carries only the keys GmfDumper needs: `UseModuleOffsets = 1` under `[ObjectDumper]`, `HookProcessConsoleExec = 1` under `[Hooks]` and `DumpKey = F8` under `[GmfDumper]`. Open the game's real `UE4SS-settings.ini` and merge only those keys into their matching sections, overwriting just them. Never replace the real file with the fragment and never touch keys it does not mention (mods paths, hot reload, engine version overrides).

## Enabling mods

Mods live under `<GameInternalName>/Binaries/Win64/Mods/`. Two ways to enable one:

- **`mods.txt`** (in `Mods/`, or where `ControllingModsTxt` points): one `ModName : 1` or `ModName : 0` per mod. Preferred, because line order is **load order**; add new lines above the built-in `Keybinds : 1` line near the bottom.
- **`enabled.txt`**: an empty file in the mod's own folder (`Mods/<ModName>/enabled.txt`). Its presence, not contents, makes UE4SS load the mod, independent of `mods.txt`. Simpler for end-user distribution but bypasses `mods.txt` and gives no load-order control; fine for a helper mod whose order does not matter.

If `[Overrides] ControllingModsTxt` is set, only that `mods.txt` is consulted and per-directory `mods.txt` and `enabled.txt` elsewhere are ignored for enable and disable.

## How to verify UE4SS is running

Before assuming something is broken:

- Press a default console-toggle key (`@` or `F10`) in game to open the console.
- Check `UE4SS.log` (beside `ue4ss.dll`) has fresh timestamps and no errors.
- If `[Debug] GuiConsoleEnabled` and `GuiConsoleVisible` are `1`, confirm the GUI console window (OpenGL-rendered) appears.

If any fails, or one mod does not show up, that is triage: `unreal.debugging`.
