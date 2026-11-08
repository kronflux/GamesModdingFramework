---
name: unreal.pak
title: Unreal pak and IoStore packaging
description: Read and write pak and IoStore containers with repak and retoc, and know which one a game uses.
engine: unreal
tags: [pak, repak, retoc, iostore, packaging]
confidence: observed
sources: [repak README (v0.2.3), retoc README (v0.1.5), gmf run on a UE 5.6 IoStore title 2026-11-07, Unreal Engine pak format notes, earlier Unreal modding framework notes]
---

# Unreal pak and IoStore packaging

For Blueprint mods loaded through BPModLoaderMod (LogicMods, load order, cook and pack steps) see `unreal.pak.blueprint`.

Unreal ships cooked content in `.pak` files under `Content/Paks/`. UE5 games may
also use IoStore containers (`.utoc` and `.ucas`).

## Reading

- repak lists and unpacks a pak (`repak list`, `repak unpack -i <entry>`); it
  reads encrypted paks with `--aes-key`.
- retoc reads IoStore containers: `retoc list --path <utoc>` and
  `retoc to-legacy --filter <name> <Paks dir> <out dir>` (see `unreal.asset-pipeline`).
- A `.sig` file beside a pak is a signature, not an index. Do not edit it.
- Asset paths inside the pak use the game mount point, for example
  `/Game/Content/...`.

## Writing

1. Cook or prepare the replacement asset outside the game folder.
2. Pack with `unreal.pack_mod`: repak for pak games, retoc `to-zen` for
   IoStore games.
3. Never change the game's own containers. A mod is a separate `<Name>_P`
   container in `Content/Paks/~mods`.
4. Name the pak so it loads in the intended order. Unreal reads paks by mount
   point and load order; a patch pak that does not override the original is
   ignored.
5. Validate by launching the game or by converting the mod back with retoc
   and UAssetGUI.

## Pitfalls

- A pak with a mismatched engine version fails to mount.
- IoStore and pak content can both exist. Replacing one does not replace the
  other.
- Encrypted assets need the key the game uses (`unreal.extract_assets` takes
  `aesKey`, `GMF_AES_KEY` or `gmf.local.json`). Do not commit a key or a
  decrypted asset.
- A replacement that changes the asset class or the import table can crash the
  cooker and the game.
