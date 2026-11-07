---
name: unity.assets.textures
title: Texture replacement at runtime
description: What Texture2D.LoadImage can load, applying a replacement with material versus sharedMaterial, finding the right material, preserving import settings, the RGBA32 memory cost, compressed formats and IL2CPP notes.
engine: unity
tags: [textures, assets, materials, memory, loadimage, il2cpp]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Texture replacement

Replacing game textures at runtime from a mod. Overview: `unity.assets`; compressed textures need `unity.assets.bundles`.

## What loads at runtime

`Texture2D.LoadImage(byte[])` decodes **PNG and JPG only**. TGA, DDS, PSD, TIFF and EXR are editor-import formats and are not supported. The result is always an uncompressed RGBA32 texture (see memory cost).

## Basic replacement

```csharp
public static Texture2D LoadPng(string path)
{
    if (!File.Exists(path)) { Logger.LogError($"Texture not found: {path}"); return null; }
    var tex = new Texture2D(2, 2, TextureFormat.RGBA32, mipChain: false);   // LoadImage replaces the dimensions
    if (!tex.LoadImage(File.ReadAllBytes(path)))
    {
        Logger.LogError($"Not a valid PNG/JPG: {path}");
        UnityEngine.Object.Destroy(tex);
        return null;
    }
    tex.name = Path.GetFileNameWithoutExtension(path);
    return tex;
}
```

```csharp
renderer.material.mainTexture = newTexture;        // this renderer's material instance only
renderer.sharedMaterial.mainTexture = newTexture;  // every renderer sharing the material
```

`renderer.material` **instantiates a copy** on first access and the copy leaks unless destroyed; `sharedMaterial` mutates the original. Per-object change: `material`. Global retexture: `sharedMaterial`.

Other slots: `mat.SetTexture("_MainTex", albedo)`, `"_BumpMap"`, `"_EmissionMap"`. Slot names are shader-specific; list them with `mat.shader.GetPropertyCount()` and `GetPropertyName(i)` instead of assuming Standard shader names.

## Finding the right material

The difficulty is locating the target, not loading the texture. Dump once with `Resources.FindObjectsOfTypeAll<Texture2D>()` (every loaded texture, including ones in no scene) and the renderers (`r.gameObject.name`, `r.sharedMaterial?.name`, `r.sharedMaterial?.mainTexture?.name`), then match by name. UnityExplorer is faster: click an object in game and read its material and texture names.

```csharp
private static readonly Dictionary<string, Texture2D> Replacements = new();

private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
{
    foreach (var r in UnityEngine.Object.FindObjectsOfType<Renderer>())
    {
        var mat = r.sharedMaterial;
        var current = mat?.mainTexture;
        if (current != null && Replacements.TryGetValue(current.name, out var replacement))
            mat.mainTexture = replacement;
    }
}
```

`FindObjectsOfType` is expensive: scene load only, never `Update`. **Inferred for newer Unity:** Unity 2023 and later mark `FindObjectsOfType` obsolete in favour of `FindObjectsByType`; use whichever the game's Unity version provides.

## Preserving import settings

Copy settings or they are lost: `newTex.wrapMode = oldTex.wrapMode; newTex.filterMode = oldTex.filterMode; newTex.anisoLevel = oldTex.anisoLevel; newTex.Apply(updateMipmaps: true, makeNoLongerReadable: false);`. A mismatched `wrapMode` is the usual cause of visible seams. Keep dimensions identical where possible: UVs are authored against the original layout and a different aspect ratio distorts the mapping.

## Memory cost

`LoadImage` gives RGBA32, 4 bytes per pixel, roughly **8 times the original** DXT1/BC1:

| Size | RGBA32 | Original DXT1/BC1 |
|---|---|---|
| 512x512 | 1 MB | ~0.13 MB |
| 1024x1024 | 4 MB | ~0.5 MB |
| 2048x2048 | 16 MB | ~2 MB |
| 4096x4096 | 64 MB | ~8 MB |

A few dozen 2K textures add hundreds of MB of VRAM, a common cause of "the game runs out of memory with your mod". Mitigations: ship the smallest acceptable resolution; `tex.Compress(highQuality: false)` after loading (lossy, costs a moment, restores most memory); use an AssetBundle for many textures (they keep compressed formats); load on demand.

## Compressed formats

1. **AssetBundle** (recommended): import in an editor project matching the game's Unity version, set compression in import settings, build for the game's target (`unity.assets.bundles`).
2. **Raw texture data**: `new Texture2D(width, height, TextureFormat.DXT5, mipChain: true); tex.LoadRawTextureData(rawBytes); tex.Apply();`. It does no validation: a wrong byte layout (format, dimensions, mip layout) renders garbage or crashes the driver.

## IL2CPP notes

- `File.ReadAllBytes` marshals to `LoadImage` normally.
- Texture references from game code are interop proxies; check `tex != null && !tex.WasCollected`.
- `Resources.FindObjectsOfTypeAll<T>()` returns an `Il2CppReferenceArray<T>`; iterate by index rather than assuming a BCL array.
