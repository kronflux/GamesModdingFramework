---
name: unity.asset-tools
title: Unity asset tools, the default and the fallbacks
description: Which tool gmf uses to export, inspect and replace Unity assets, what each fallback does better, and the exact commands to run one when the default fails.
engine: unity
tags: [assets, assetstudio, assetripper, unitypy, uabea, assetstools, il2cpp, extraction, tools]
confidence: observed
sources: [aelurum/AssetStudio v0.20.0 release and AssetStudioCLI/ReadMe.md (2026-11-07), AssetRipper 2.0.0 source Arguments.cs, WebApplicationLauncher.cs and Pages/Commands.cs (2026-11-07), UnityPy 1.25.4 README and PyPI (2026-11-07), nesrak1/UABEA and AssetsTools.NET releases (2026-11-07), gmf runs on a Unity 6000.3 IL2CPP title 2026-11-07]
---

# Unity asset tools

| Job | Default | Fallbacks, in order |
|---|---|---|
| Export assets to browse or reuse | AssetStudioModCLI (`unity.extract_assets`) | AssetRipper headless, UnityPy script |
| Full Unity project, scenes, prefabs | AssetRipper headless | none maintained |
| Inspect objects and path ids | UnityPy (`unity.inspect_asset`) | AssetStudioModCLI `-m info` or `-m jsonDump` |
| Replace one object | UnityPy (`unity.replace_asset`) | UABEA (GUI), AssetsTools.NET (library) |

## AssetStudioModCLI (default export)

- aelurum's AssetStudio fork, MIT, v0.20.0 (2026-11-01), Unity 6 up to 7000.0. `gmf tool install assetstudio` installs the .NET Framework 4.7.2 build on Windows, which needs no extra runtime, and checks GitHub's SHA-256.
- Command shape: `AssetStudioModCLI <file or folder> -m export -t <types> -o <dir> [--filter-by-name <names>] [--unity-version <v>] [--assembly-folder <dir>]`. Types: `tex2d, sprite, textAsset, monoBehaviour, font, shader, audio, video, mesh, all`.
- **Verified on a Unity 6000.3 IL2CPP game:** `resources.assets` exported 805 assets: 677 MonoBehaviour JSON files, 123 PNGs and 5 text files. Two "Font Texture" textures failed to convert; gmf lists such lines under `errors`.
- **IL2CPP:** MonoBehaviour fields need Cpp2IL dummy assemblies. Run `unity.decompile --input backend=il2cpp --input format=dummydll` once; `unity.extract_assets` then passes `decompiled/unity/il2cpp/DummyDll` automatically.
- **Load the data folder, not one file, for MonoBehaviours.** A MonoBehaviour's script usually lives in another file. Loaded alone, `resources.assets` gave `ContentSizeFitter` only its base fields; loaded with the whole data folder and `--filter-by-name ContentSizeFitter`, it gave `m_HorizontalFit` and `m_VerticalFit`.
- It does not write assets and does not build a Unity project.

## When AssetStudioModCLI fails or is not enough

**AssetRipper (headless web server).** Use it for a full Unity project export (scenes, prefabs, materials, C# from MonoScripts) or when AssetStudio cannot read a file. GPL-3.0, so gmf downloads it and never ships it (`gmf tool install assetripper`). AssetRipper 2.0.0 (2026-08-24) has no export command line; it runs a local server:

1. Start it: `AssetRipper.GUI.Free --headless --port 8642`. `--headless` turns off the browser and dialogs. Start it as a process you own and stop it by its process id when done.
2. Load: `POST http://127.0.0.1:8642/LoadFolder` with form field `Path=<game data folder>` (`/LoadFile` for one file).
3. Export: `POST /Export/UnityProject` (full project) or `POST /Export/PrimaryContent` (models as GLB, images, audio, text, JSON for other types), each with `Path=<output folder inside the workspace>`. Add `CreateSubfolder=true` to write into a timestamped subfolder.
4. Settings: `POST /Settings/Update` takes the whole settings form; a field left out is reset (reported by users, not documented).

AssetRipper states support up to Unity 6000.4. The route names come from its source; `/Export/PrimaryContent` is not documented and has not been run by gmf.

**UnityPy script.** When both tools choke on one file, a short Python script with the UnityPy that `gmf tool install unitypy` installed can read objects one by one (`UnityPy.load(path)`, `obj.parse_as_object()`, `data.image.save(...)` for textures, `obj.read_typetree()` for anything with a type tree). Run it with the tool's Python, from a folder of its own.

**UABEA and AssetsTools.NET.** UABEA is a GUI (last release v8, 2024-11) with only an early, bundle-only command line in third-party forks. AssetsTools.NET is the library under it; Unity 6 support is not stated. Use them only by hand, when UnityPy cannot write a format.

## Not worth using

- AssetRipper command-line forks (LiveGobe/AssetRipper.CLI, MeikoMei16/AssetRipper-CLI): no releases and behind upstream.
- Perfare's original AssetStudio and Il2CppDumper: stale and without Unity 6 metadata support.
