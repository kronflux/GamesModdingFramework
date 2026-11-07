---
name: unity.assets.bundles
title: AssetBundle workflows for mods
description: When a mod needs an AssetBundle, matching the game's Unity version and build target, building with BuildPipeline, loading sync, async and embedded, magenta shader fixes, unloading and distribution.
engine: unity
tags: [assetbundle, assets, shaders, unity-version, loading, distribution]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# AssetBundle workflows

Building and loading AssetBundles for mods: the supported route for shipping models, prefabs, compressed textures and anything else Unity cannot import at runtime. Overview: `unity.assets`. Related: `unity.assets.textures`, `unity.assets.models-audio`.

## When you need a bundle

| Asset | Runtime-loadable directly? | Route |
|---|---|---|
| PNG / JPG texture | Yes | `Texture2D.LoadImage` |
| WAV / OGG / MP3 audio | Yes | `UnityWebRequestMultimedia.GetAudioClip` |
| Compressed texture (DXT/BCn) | No | Bundle |
| Mesh or model (FBX, OBJ) | No | Bundle, or build the `Mesh` in code |
| Prefab, Material, Shader, AnimationClip, ScriptableObject | No | Bundle |

## Matching the game's Unity version

Two hard constraints:

1. **Build with the same Unity version as the game.** The serialization format is tied to it. A mismatch usually fails to load; sometimes it loads and deserializes garbage, which is worse.
2. **Build for the game's build target.** A StandaloneWindows64 bundle will not load in a macOS or Linux build; ship one per platform.

Find the game's Unity version in `<Game>_Data/globalgamemanagers` (the string is near the start: `strings ... | head -20`), in `<Game>_Data/boot.config`, in the BepInEx log line `Running under Unity v<version>`, or in UnityExplorer. Install that exact version through Unity Hub.

## Building a bundle

In an editor project on the matching version: import the asset, assign an AssetBundle name in the Inspector's bottom panel, and add an editor script:

```csharp
using UnityEditor;
using System.IO;

public static class BundleBuilder
{
    [MenuItem("Modding/Build AssetBundles")]
    public static void Build()
    {
        const string outDir = "AssetBundles";
        Directory.CreateDirectory(outDir);
        BuildPipeline.BuildAssetBundles(outDir,
            BuildAssetBundleOptions.None,          // ChunkBasedCompression for LZ4
            BuildTarget.StandaloneWindows64);      // match the game's target
    }
}
```

Compression: `None` is LZMA (smallest, slowest load, whole bundle decompressed at once); `ChunkBasedCompression` is LZ4 (larger, much faster, partial loading; **preferred for mods**, the load hitch matters more than size); `UncompressedAssetBundle` is largest and fastest.

## Loading a bundle

Synchronous, fine during plugin startup:

```csharp
string path = Path.Combine(Path.GetDirectoryName(Info.Location), "mybundle");
var bundle = AssetBundle.LoadFromFile(path);
if (bundle == null) { Logger.LogError($"Failed to load bundle at {path}: Unity version or platform mismatch?"); return; }
var prefab = bundle.LoadAsset<GameObject>("MyPrefab");
var instance = UnityEngine.Object.Instantiate(prefab);
```

Asynchronous, for gameplay. Unity's `AsyncOperation` is **not awaitable** in stock Unity and has no `AsTask()`; use a coroutine:

```csharp
public IEnumerator LoadBundleAsync(string path, Action<AssetBundle> onLoaded)
{
    var request = AssetBundle.LoadFromFileAsync(path);
    yield return request;
    onLoaded?.Invoke(request.assetBundle);   // null on failure
}
```

Embedding avoids a loose file: `AssetBundle.LoadFromStream(Assembly.GetExecutingAssembly().GetManifestResourceStream("MyMod.Resources.mybundle"))`, with `<EmbeddedResource Include="Resources\mybundle" />` in the csproj.

`LoadFromFile` returning null has three usual causes, in order: Unity version mismatch, wrong build target, or a bundle of that name already loaded.

## Shader problems

The most common failure after version mismatch: **materials render magenta**. Shaders are stripped or mismatched between your editor project and the game build. Options:

1. **Reuse the game's shaders** (more reliable; loses custom shader properties):

```csharp
var shader = Shader.Find("Standard");            // or a game-specific name
foreach (var r in instance.GetComponentsInChildren<Renderer>())
    foreach (var m in r.materials) m.shader = shader;
```

Enumerate shaders with `Resources.FindObjectsOfTypeAll<Shader>()` to find the name.

2. Include the shader in the bundle and keep it from being stripped: add it to Always Included Shaders (Project Settings, Graphics).

## Unloading and lifetime

Only one bundle of a given name can be loaded at a time; a second `LoadFromFile` returns **null**, not the existing instance, a frequent surprise on mod reload.

```csharp
bundle.Unload(unloadAllLoadedObjects: false);  // frees the bundle, keeps instantiated assets
bundle.Unload(unloadAllLoadedObjects: true);   // also destroys everything loaded from it
```

Use `false` after instantiating what you need. Use `true` only on full teardown; anything still referencing those assets gets destroyed objects (Unity fake null). With hot reload (ScriptEngine), unload in `OnDestroy` or the next load returns null.

## Distribution

- Ship the bundle **beside the DLL** in the plugin folder, or embed it.
- Locate it relative to your assembly, not the working directory: `Path.GetDirectoryName(Info.Location)` (BepInEx) or `Path.GetDirectoryName(MelonAssembly.Location)`.
- One bundle per platform if you support more than Windows; name them distinctly and choose with `Application.platform`.
- **Do not ship bundles containing extracted original game assets.** Redistributing game content is copyright infringement and grounds for Thunderstore delisting. Ship only assets you created or may redistribute.
