---
name: unreal.asset-pipeline
title: Unreal asset mods with retoc, repak and UAssetGUI
description: Extract a cooked asset, edit it as JSON and ship it as a <Name>_P pak or IoStore set in Content/Paks/~mods, with the exact commands gmf runs and what was verified on a UE 5.6 IoStore game.
engine: unreal
tags: [assets, iostore, pak, retoc, repak, uassetgui, usmap, mods, datatable]
confidence: verified
sources: [trumank/repak v0.2.3 README and --help, trumank/retoc v0.1.5 README and --help, atenfyr/UAssetGUI README (v1.1.1 experimental), Dmgvol UE_Modding ExtractingIoStore guide, gmf run on a UE 5.6 IoStore title 2026-11-07]
---

# Unreal asset mods

A cooked asset is never edited in place. It is copied out, converted to JSON,
edited, converted back and shipped in a separate container whose name ends in
`_P` (patch priority), in `Content/Paks/~mods`.

| Step | gmf operation | Tool command |
|---|---|---|
| Extract | `unreal.extract_assets --input filter=<name>` | `retoc to-legacy --filter <name> <Content/Paks> <out>` (IoStore) or `repak list` then `repak unpack -o <out> -i <entry>...` (pak) |
| Inspect | `unreal.inspect_asset --input assetPath=<mount path>` | `UAssetGUI tojson <asset> <json> <major.minor> <usmap>` |
| Stage | `unreal.stage_asset --input mod=<Mod> --input jsonPath=<json>` | `UAssetGUI fromjson <json> mods/<Mod>/pak/<mount path> <usmap>` |
| Pack | `unreal.pack_mod --input mod=<Mod>` | `retoc to-zen --version UE5_x <pak dir> <Mod>_P.utoc` (IoStore) or `repak pack --version V11 <pak dir> <Mod>_P.pak` |
| Deploy | `unreal.deploy --input type=pak` | copies `dist/` to `Content/Paks/~mods` (game write) |
| Remove | `unreal.remove_mod --input name=<Mod>` | backs up and deletes the `_P` files |

## What a game ships

- `Content/Paks/*.utoc` and `.ucas` beside a small `.pak` mean IoStore (UE5).
  A mod for an IoStore game must also be IoStore: `.pak`, `.utoc` and `.ucas`
  with the same `_P` name, made by `retoc to-zen`.
- Only `.pak` files mean a legacy pak game; `repak pack` makes the mod. repak
  writes pak version 11 for UE 4.26 and later; upstream tested it up to 5.3.
- `LogicMods/` is the UE4SS Blueprint mod loader's folder, not the place for
  asset overrides.

## Mappings and engine version

- UE5 cooks assets with unversioned properties; UAssetGUI needs the game's
  `.usmap` to read them. UE4SS writes one (Ctrl+Numpad6, or `unreal.dump`);
  gmf takes the newest `.usmap` under `dumps/`.
- The engine version is `major.minor` (`5.6`) for UAssetGUI and `UE5_6` for
  retoc; gmf takes it from the profile.
- gmf pins UAssetGUI to `experimental-latest` (v1.1.1): the stable v1.1.0
  accepts neither a `.usmap` path nor `5.6`-style versions.

## Verified on a UE 5.6 IoStore title, 2026-11-07

- `unreal.extract_assets --input filter=DT_<Name>` converted one
  asset (`.uasset` + `.uexp`) in about a second; the 4.7 GB `.ucas` was only
  read. The legacy files keep the mount path `<Project>/Content/...`; an
  asset extracted elsewhere needs `--input mountPath=<Project>/Content/.../Asset.uasset`
  on `unreal.inspect_asset`, which otherwise refuses it.
- `unreal.inspect_asset` found the profile's `5.6` and the UE4SS `.usmap`, and
  UAssetGUI ran headless (exit 0). The tips are `CultureInvariantString` values
  in a `DataTableExport`.
- After editing 18 tips, `stage_asset` and `pack_mod` produced
  `<Mod>_P.pak` (347 bytes), `.utoc` (475) and `.ucas`.
- Round trip: the packed mod converted back with retoc and UAssetGUI contained
  the edited text and not the original.
- **In game:** with the three `_P` files in
  `Content/Paks/~mods`, the loading screens showed the edited tips. The mod was
  then removed with `unreal.remove_mod`.
- Converting a mod container back alone fails with "does not contain ...
  ScriptObjects": retoc needs the game's `global.utoc`/`.ucas` beside it.
  Copy those two small files into a scratch folder with the mod.

## Pitfalls

- Edit values, not structure: adding exports, changing classes or import
  tables can crash the game.
- A JSON written by UAssetGUI is pretty-printed (`"Key": "value"`); a search
  pattern must allow the space after the colon.
- Encrypted games need the AES key (`--aes-key` for retoc and repak). gmf does
  not look keys up; do not commit one.
- Never commit extracted assets, JSON from them or built mod containers made
  from game content.
