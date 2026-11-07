---
name: unity-assets
description: Use when a Unity mod must extract, inspect, replace or load assets such as textures, models, audio or AssetBundles.
operations: [unity.extract_assets, unity.inspect_asset, unity.replace_asset, generic.backup]
knowledge: [unity.assets, unity.asset-tools, unity.assets.bundles, unity.assets.textures, unity.assets.models-audio]
---

# Unity assets

This skill routes asset work. Prefer a mod that loads content at runtime over
overwriting a shipped asset; overwrite only after a backup.

## Steps

1. Read the safe workflow first: `gmf knowledge show unity.assets`.
2. Export into the workspace with AssetStudioModCLI (`gmf tool install assetstudio` once):
   `gmf run unity.extract_assets --input types=<tex2d,sprite,textAsset,monoBehaviour,audio,mesh or all> --input filter=<name>`.
   Without `assetPath` it loads the whole data folder, which MonoBehaviours need for their fields. On IL2CPP, first run `gmf run unity.decompile --input backend=il2cpp --input format=dummydll`. Read `errors` and `notes` in the result. If AssetStudio fails or you need a full Unity project, follow the fallbacks in `gmf knowledge show unity.asset-tools`.
3. Inspect one asset before changing it:
   `gmf run unity.inspect_asset --input assetPath=<asset>`.
4. Pick the track and read its note:
   - AssetBundle loading: `gmf knowledge show unity.assets.bundles`
   - textures: `gmf knowledge show unity.assets.textures`
   - meshes and audio: `gmf knowledge show unity.assets.models-audio`
5. Back up the target: `gmf run generic.backup --input gamePath=<file>`.
6. Replace one object: `gmf run unity.replace_asset --input assetPath=<asset> --input object=<path id or name> --input replacementPath=<file>`.
   Take the path id from `unity.inspect_asset`. A Texture2D or Sprite takes an image, a TextAsset any file, and other types a `.json` object of type-tree fields. The changed file is written under `extracted/unity/replaced/` first, then the game file is backed up and replaced; it needs a `gameWrite` authorization. UnityPy comes from `gmf tool install unitypy`.
7. Verify by hash with `gmf run generic.hash` and by inspecting the asset again.

## Evidence

Record the source asset name and type, the Unity version, the backup path and
hash, the replacement hash and the inspect result after the write.

## Pitfalls

- A bundle must be built for the game's exact Unity version and build target
  (`unity.assets.bundles`).
- `material` clones the material while `sharedMaterial` changes every user
  (`unity.assets.textures`).
- Models usually need a bundle or a mesh built in code
  (`unity.assets.models-audio`).
- Never commit extracted assets. Anti-cheat is risk information, not a block;
  note that file changes may be detected, then continue.
- Do not launch the game to check without a `launchGame` authorization.
