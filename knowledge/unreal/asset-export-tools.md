---
name: unreal.asset-export
title: Tools that export Unreal assets (textures, meshes, audio, animation)
description: Which tools read cooked Unreal content out of pak and IoStore containers, what each covers, and when a mod needs them. Not part of the first dump.
engine: unreal
tags: [assets, export, textures, meshes, audio, cue4parse, fmodel, umodel, iostore]
confidence: inferred
sources: [FabianFG/CUE4Parse README and source, 4sval/FModel README, gildor2/UEViewer README, tool survey of 2026-11-12 (web reading only; none of these tools was run by gmf)]
---

# Asset export tools

The first dump and `gamedocs/` describe how a game works. They do not contain
pictures, models or sounds. A mod needs an export tool only when it must look
at or reuse that content, for example to repaint a texture or match a mesh.

Everything below is from each project's own documentation, read on 2026-11-12.
gmf has not run these tools; check the project page before relying on a claim.

| Tool | What it is | Covers | Notes |
|---|---|---|---|
| CUE4Parse | C# library, Apache-2.0 | Reads pak and IoStore; exports textures, meshes, animations, audio, localization; lists UE 5.6 among its game versions | A library, not a program: it needs a small C# host. Needs the game's `.usmap` for UE5 unversioned assets (GmfDumper writes one). |
| FModel | Desktop program built on CUE4Parse, GPL-3.0 | The same content, with a browser and previews | No command line was found, so it cannot be driven by gmf. Good for a person to browse. |
| UEViewer (umodel) | Program, own licence | UE1 to UE4 | Not for UE5 games. |
| retoc, repak, UAssetGUI | Already registered in gmf | Extract and repack containers; assets as JSON | For editing data, not for viewing pictures or models. See `unreal.asset-pipeline`. |

## Choosing

- To edit values in a data table or a Blueprint default: use the registered
  tools (`unreal.asset-pipeline`). No export tool is needed.
- To see or reuse a texture, mesh or sound: the user opens the game in FModel,
  with the `.usmap` from the dump and, for an encrypted game, the AES key.
- To automate export: a small host program on CUE4Parse. This is not built.

## Pitfalls

- Exported content is copyrighted game content. It stays in the workspace and
  is never committed or redistributed.
- UE5 assets are unversioned; without the matching `.usmap` a reader fails or
  shows wrong values.
