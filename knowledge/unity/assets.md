---
name: unity.assets
title: Unity asset extraction and replacement
description: Extract bundles and assets into the workspace with AssetStudioModCLI (fallbacks in unity.asset-tools) and replace an asset with UnityPy only after a backup.
engine: unity
tags: [assets, assetstudio, assetripper, unitypy, bundles, replacement]
confidence: observed
sources: [AssetRipper documentation, UnityPy documentation, Unity asset bundle format notes, earlier Unity modding framework notes]
---

# Unity asset extraction and replacement

Per-kind runtime detail is in `unity.assets.bundles`, `unity.assets.textures` and `unity.assets.models-audio`.

Unity games store runtime assets in bundles, `resources.assets` or
`sharedassets` files, and raw files under `*_Data`.

## Extraction

1. Confirm the backend and the data folder from the profile.
2. Run `unity.extract_assets` with the game folder and an output folder under
   the workspace `extracted/` directory.
3. `unity.extract_assets` runs AssetStudioModCLI, which exports individual
   assets. AssetRipper exports a full Unity project when that is needed, and
   UnityPy reads and writes individual objects; see `unity.asset-tools`.
4. Record the tool version and the source asset in evidence.

Output stays under the workspace. It is gitignored and never committed.

## Replacement

1. Extract the original asset and record its hash.
2. Run `generic.backup` on the target asset file.
3. Use `unity.replace_asset` with the object's path id and a replacement file; gmf's UnityPy helper writes the changed asset file into the workspace before the game file is backed up and replaced.
4. Repack only the affected bundle. A full rebuild changes unrelated assets.
5. Validate by loading the game or by re-reading the replaced object.

## Pitfalls

- A texture or mesh replacement can break a prefab reference. Compare object
  names and paths, not only types.
- Some bundles are compressed or encrypted. A parser that silently stops is not
  proof the asset is absent.
- AssetRipper and FModel are GPL. Download them at runtime; never vendor them.
- Never commit an extracted asset even when it looks like a small text file.

## Replacement at runtime and discovery

The sections above cover offline replacement. This section covers the runtime workflow. Details per asset kind: `unity.assets.textures`, `unity.assets.models-audio`, `unity.assets.bundles`.

### What a mod can load at runtime

A mod has no editor, so it can load much less than the editor can import.

- **Textures**: `Texture2D.LoadImage` decodes PNG and JPG only. GPU formats (BCn/DXT) go in an AssetBundle or `LoadRawTextureData`.
- **Models**: no runtime importer for FBX, OBJ or glTF; use an AssetBundle or build the `Mesh` in code.
- **Audio**: WAV and OGG through `UnityWebRequestMultimedia.GetAudioClip`; `File.ReadAllBytes` alone gives no `AudioClip`.
- **Bundles**: build-target specific and tied to the game's Unity version; one bundle name loads once (call `Unload` before reloading).
- Unity's `AsyncOperation` is not awaitable in stock Unity: use a coroutine. `await AssetBundle.LoadFromFileAsync(path)` needs UniTask or a custom awaiter.

Workflows: texture mod (extract, edit as PNG, load, apply to renderers); model mod (extract, edit in Blender, FBX, import to a matching editor project, bundle, load); audio pack (WAV or OGG, organize by music, sfx and voice, bundle or load by URL, replace `AudioSource` clips). Keep replacement names unique to avoid conflicts, cache loaded assets, call `Resources.UnloadUnusedAssets()` when done, and prefer LZ4 bundle compression.

Troubleshooting: a texture not applying means check the path, the format, a valid material and nulls; a bundle load failure means Unity version, path accessibility, corruption, build settings; no audio means format support, `AudioSource` configuration, clip loaded, sample rate and channels.

### Asset discovery

Finding what assets are called is usually the larger half of an asset mod. The running game is the most reliable source, since its names are what your code matches.

```csharp
foreach (var t in Resources.FindObjectsOfTypeAll<Texture2D>()) Logger.LogInfo($"TEX {t.name} {t.width}x{t.height} {t.format}");
foreach (var m in Resources.FindObjectsOfTypeAll<Material>())  Logger.LogInfo($"MAT {m.name} shader={m.shader?.name} tex={m.mainTexture?.name}");
foreach (var c in Resources.FindObjectsOfTypeAll<AudioClip>()) Logger.LogInfo($"CLIP {c.name} {c.length:F2}s {c.channels}ch {c.frequency}Hz");
foreach (var mesh in Resources.FindObjectsOfTypeAll<Mesh>())   Logger.LogInfo($"MESH {mesh.name} verts={mesh.vertexCount} subs={mesh.subMeshCount}");
```

`FindObjectsOfTypeAll` includes assets in no scene and objects with `HideFlags`; `FindObjectsOfType` misses most of them. Dump to a file (for example a `texture-dump.tsv` under the plugin folder), not the log, which is truncated, and trigger it from a key binding, not on every startup. Names are often empty or duplicated; then match on a composite (dimensions plus format for textures, vertex count for meshes, length plus channels for clips).

- **UnityExplorer** beats any dump for interactive work: live hierarchy, inspector and a C# console in the game. Click the object, read its `Renderer`, `sharedMaterial.name` and `mainTexture.name`, key the replacement on those. Install the build matching your loader (BepInEx Mono, BepInEx IL2CPP and MelonLoader builds are published separately).
- **AssetStudioModCLI** exports textures, sprites, audio, text, MonoBehaviours and meshes (`gmf run unity.extract_assets`). **AssetRipper** exports a full Unity project from `<game-dir>/<Game>_Data` through its headless server (GPL-3.0: link to it, never vendor it; steps in `unity.asset-tools`). The exported assets are copyrighted game content: use them as reference, do not commit or redistribute them (a Thunderstore delisting cause). UABE views and modifies Unity assets by hand.

| Path | Contents |
|---|---|
| `<Game>_Data/resources.assets` | Assets in the built-in resources |
| `<Game>_Data/sharedassets*.assets` | Per-scene shared assets |
| `<Game>_Data/level*` | Scene data |
| `<Game>_Data/StreamingAssets/` | Loose files, often readable AssetBundles; occasionally loose PNG or OGG a mod can replace by overwriting (check first) |
| `<Game>_Data/*.bundle`, `*.unity3d` | AssetBundles |
| `<Game>_Data/globalgamemanagers` | Settings; contains the Unity version string |

Keep the name map as data (a `textures.json` beside the DLL, `{ "originalName": "replacement.png" }`) so a game patch does not mean recompiling, and log every key that never matched after a scene load: silent no-ops are the usual symptom of a patch renaming assets. Keep discovery cheap: scan on `SceneManager.sceneLoaded`, never per frame, cache resolved references, filter by name before touching materials, guard the pass behind a config toggle and log its duration (an 800 ms pass on scene load is a stutter users will report).
