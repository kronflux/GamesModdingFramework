---
name: unity.assets.models-audio
title: Model and audio replacement
description: Why models need an AssetBundle or a mesh built in code, swapping meshes and skinned meshes in place, building a Mesh, which audio formats load at runtime, loading clips with UnityWebRequest, and finding the right AudioSource.
engine: unity
tags: [models, audio, mesh, audioclip, assets, skinnedmesh, assetbundle]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Model and audio replacement

Overview: `unity.assets`. Bundles: `unity.assets.bundles`.

## Models: the constraint

**Unity has no runtime importer for FBX, OBJ, 3DS, DAE or glTF**; a mod cannot read a `.fbx` and turn it into a `Mesh`. Two options only:

1. **AssetBundle**, the normal route: import in an editor project matching the game's Unity version, build a bundle, load it at runtime.
2. **Construct the `Mesh` in code** (vertices, triangles, normals, UVs): fine for simple or procedural geometry, impractical for authored art.

Any guide that says "export to FBX and load it at runtime" skipped the bundle step. Third-party runtime importers (glTF loaders such as glTFast, or OBJ parsers you write) are libraries you ship and depend on, not Unity functionality.

## Model replacement workflow

1. Extract the original (AssetRipper) to learn scale, orientation, pivot and, if skinned, the skeleton.
2. Edit in Blender or Maya matching the original's scale and axes; Unity is Y-up, left-handed.
3. Export FBX.
4. Import into an editor project on the **game's Unity version**.
5. Assign an AssetBundle name; build for the game's build target.
6. Ship the bundle; load and instantiate at runtime.

Steps 4 and 5 are mandatory. For a **skinned** mesh the replacement must keep the original's bone names and hierarchy or existing animations will not drive it: the hardest part of model modding. A static prop is straightforward; a rigged character is not.

## Swapping a mesh in place

```csharp
// Static mesh
target.GetComponent<MeshFilter>().mesh = replacementMesh;

// Skinned mesh: keep the original bones and root bone
var skinned = target.GetComponent<SkinnedMeshRenderer>();
var originalBones = skinned.bones;
var originalRoot  = skinned.rootBone;
skinned.sharedMesh = replacementMesh;
skinned.bones      = originalBones;    // reassign after changing the mesh
skinned.rootBone   = originalRoot;
```

Reassign `bones` after `sharedMesh`: setting the mesh can invalidate the binding, and the symptom is a model collapsed to the origin.

Replacing the whole GameObject is often simpler for props:

```csharp
var replacement = UnityEngine.Object.Instantiate(prefabFromBundle, original.transform.parent);
replacement.transform.localPosition = original.transform.localPosition;
replacement.transform.localRotation = original.transform.localRotation;
replacement.transform.localScale    = original.transform.localScale;
original.SetActive(false);   // prefer disabling to destroying: game code may hold references
```

Disable rather than `Destroy`; game code often holds references it does not null-check and a destroyed object gives fake-null crashes far from your mod.

## Building a mesh in code

```csharp
var mesh = new Mesh { name = "MyQuad" };
mesh.vertices  = new[] { new Vector3(-0.5f, -0.5f, 0), new Vector3(0.5f, -0.5f, 0),
                         new Vector3(-0.5f,  0.5f, 0), new Vector3(0.5f,  0.5f, 0) };
mesh.uv        = new[] { Vector2.zero, Vector2.right, Vector2.up, Vector2.one };
mesh.triangles = new[] { 0, 2, 1, 2, 3, 1 };   // clockwise = front-facing
mesh.RecalculateNormals();
mesh.RecalculateBounds();                       // omit and the mesh may be culled wrongly
```

Winding sets facing; if the mesh is invisible from the front and visible from behind, reverse each triangle's indices. Over 65535 vertices needs `mesh.indexFormat = IndexFormat.UInt32`.

## Audio: what loads at runtime

Unlike models, audio **can** load at runtime through `UnityWebRequestMultimedia` with a `file://` URL:

| Format | Support |
|---|---|
| WAV | Reliable everywhere; large files |
| OGG Vorbis | Reliable on desktop; good size and quality; **preferred** |
| MP3 | Platform-dependent; avoid if OGG is possible |

`File.ReadAllBytes` alone does **not** produce an `AudioClip`; the bytes need decoding.

## Audio replacement

```csharp
public IEnumerator LoadClip(string path, AudioType type, Action<AudioClip> onLoaded)
{
    string url = "file://" + path.Replace('\\', '/');
    using var req = UnityWebRequestMultimedia.GetAudioClip(url, type);
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success)
    {
        Logger.LogError($"Audio load failed: {path}: {req.error}");
        onLoaded?.Invoke(null);
        yield break;
    }
    var clip = DownloadHandlerAudioClip.GetContent(req);
    clip.name = Path.GetFileNameWithoutExtension(path);
    onLoaded?.Invoke(clip);
}
```

`AudioType` must match the file: `OGGVORBIS`, `WAV`, `MPEG`. Older Unity versions use `req.isNetworkError || req.isHttpError` instead of `req.result`; check what the game's version supports. From decoded PCM: `var clip = AudioClip.Create("Generated", sampleCount, channels, frequency, stream: false); clip.SetData(samples, 0);` (`float[]`, interleaved, range -1 to 1).

Applying: `audioSource.clip = newClip;`, or catch one-shots with a Harmony patch, which covers sounds never assigned to `AudioSource.clip` (most sound effects):

```csharp
[HarmonyPrefix]
[HarmonyPatch(typeof(AudioSource), nameof(AudioSource.PlayOneShot), new[] { typeof(AudioClip), typeof(float) })]
static void ReplaceOneShot(ref AudioClip clip)
{
    if (clip != null && Replacements.TryGetValue(clip.name, out var replacement)) clip = replacement;
}
```

## Finding the right AudioSource

List `FindObjectsOfType<AudioSource>()` (`gameObject.name`, `clip?.name`, `volume`) and every loaded clip with `Resources.FindObjectsOfTypeAll<AudioClip>()` (name, length, channels), which finds clips the scene scan misses. Dump once, match by name after. Practice: keep replacements at the original's sample rate and channel count. Games often assume mono for positional 3D audio, and a stereo replacement plays non-positionally (a sound that does not pan with its source).
