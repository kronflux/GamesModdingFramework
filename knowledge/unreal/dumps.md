---
name: unreal.dumps
title: Unreal dump artifacts
description: Produce object, usmap and header dumps and treat each as evidence with a game build attached.
engine: unreal
tags: [dumps, usmap, headers, objects, evidence]
confidence: verified
sources: [UE4SS documentation, UAssetAPI mappings documentation, earlier Unreal modding framework notes]
---

# Unreal dump artifacts

The per-artifact catalog, native keybinds and the mod-goal to dump mapping are in `unreal.dumps.artifacts`.

A dump is a snapshot of the game build that produced it. Record that build
beside the dump.

A game's first dump runs GmfDumper once and builds Markdown pages from it: load
the skill `unreal-first-dump`, then start reading at `gamedocs/overview.md`
(`unreal.gamedocs`). The sections below apply to a single artifact.

## Kinds

- Object dump: every live UObject path, class and outer. UE4SS writes
  `UE4SS_ObjectDump.txt` next to the executable by default.
- USMAP: a compressed mappings file that describes the property layout. Tools
  such as UAssetAPI consume it for asset work.
- Header dump: C++ class and struct declarations generated from the reflection
  data. Useful for reading offsets and function signatures.
- Blueprint dump: the event graph and functions of a blueprint asset.

## Using a dump

1. Run `unreal.dump` with the kinds the job needs.
2. Keep the output under the workspace `dumps/` folder.
3. Search it with `analyze.classes`, `analyze.objects`, `analyze.references`,
   `analyze.assets` and `analyze.entrypoints`.
4. Attach the dump path and the game version to each evidence record.

## Pitfalls

- An object dump only contains objects that existed when it ran. A menu-only
  class is absent if the dump ran in the main menu.
- A usmap from another game version produces wrong property offsets.
- Dumps contain game code and names. Keep them out of git.
- A dump is not a substitute for reading the class in a decompiler when the
  question is about control flow.
