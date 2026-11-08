---
name: unreal-pak-blueprint
description: Use when an Unreal task needs pak or IoStore containers, an extracted or edited asset packed as a mod, or a Blueprint mod mounted through the LogicMods folder.
operations: [unreal.scaffold, unreal.extract_assets, unreal.inspect_asset, unreal.stage_asset, unreal.pack_mod, unreal.package, unreal.deploy, unreal.remove_mod]
knowledge: [unreal.pak, unreal.asset-pipeline, unreal.pak.blueprint]
---

# Unreal pak and Blueprint mods

This skill routes the pak track. Use it only when Lua or C++ cannot reach the
goal, because Blueprint and pak work needs an editor and a matching engine
build.

## Steps

Asset mod (change a data table, a text, a value in a cooked asset):

1. Read the pipeline: `gmf knowledge show unreal.asset-pipeline`. Install the
   tools once: `gmf tool install retoc`, `gmf tool install repak`,
   `gmf tool install uassetgui` (each needs `toolInstall`).
2. UE5 assets need a `.usmap`: dump one with UE4SS (`unreal.dump`) so it is in
   `dumps/`.
3. Extract only what you need:
   `gmf run unreal.extract_assets --input filter=<asset name>`. If the
   containers are encrypted the operation says so (`GMF-E-GAME-002`); add
   `--input aesKey=<key>` or put the key in the workspace `gmf.local.json`.
4. Convert to JSON: `gmf run unreal.inspect_asset --input assetPath=<mount path from step 3>`.
   Edit the JSON it names; change values, not structure.
5. Stage it in a mod: `gmf run unreal.stage_asset --input mod=<Mod> --input jsonPath=<json>`.
6. Pack: `gmf run unreal.pack_mod --input mod=<Mod>` (IoStore games get
   `<Mod>_P.pak`, `.utoc` and `.ucas`).
7. Deploy to `Content/Paks/~mods`: `gmf run unreal.deploy --input modDir=mods/<Mod> --input type=pak`
   (a game write; needs `gameWrite`). Remove it with
   `gmf run unreal.remove_mod --input name=<Mod>`.

Blueprint logic mod (new behaviour, needs the editor):

1. Read how the Blueprint loader discovers, orders and mounts paks:
   `gmf knowledge show unreal.pak.blueprint`.
2. Scaffold: `gmf run unreal.scaffold --input name=<mod> --input type=pak-blueprint`.
3. Package: `gmf run unreal.package --input modDir=<mod folder>`.
4. Deploy to `Content/Paks/LogicMods`: `gmf run unreal.deploy --input modDir=<mod folder>`.

## Evidence

Record the pak format (pak or IoStore), the engine version, asset paths, the
tool used, backup and output hashes, and the deploy path.

## Pitfalls

- UE5 games often use IoStore: a mod for them must ship as a `_P` set of
  `.pak`, `.utoc` and `.ucas`; `unreal.pack_mod` makes it (`unreal.asset-pipeline`).
- A Blueprint function cannot be hooked before its class is loaded (G14) and
  Blueprint names carry spaces and GUID suffixes (G28) (`unreal.mined-gotchas`).
- Load order is controlled by the loader's list file, not by file name
  (`unreal.pak.blueprint`).
- Never commit a game pak or extracted asset. Anti-cheat is risk information,
  not a block; note that modified paks can be detected, then continue.
- Do not launch the game without a `launchGame` authorization.
