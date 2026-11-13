---
name: unreal-first-dump
description: Use as the first step on an Unreal Engine game, before any mod work, to install UE4SS, run GmfDumper once and collect a verified dump of the game.
operations: [unreal.setup_ue4ss, unreal.deploy_dumper, unreal.dump, unreal.verify_dump]
knowledge: [unreal.dumps, unreal.dumps.artifacts]
---

# First dump of an Unreal game

One run of GmfDumper records how the game works: classes, structs, enums,
data tables, class defaults, Blueprint bytecode, every level's actors and the
asset list. Later mod work reads that record instead of guessing.

## Steps

1. Install UE4SS when it is missing:
   `gmf run unreal.setup_ue4ss --input gameDir=<game folder>`. It needs
   `toolInstall` and `gameWrite` authorizations.
2. Deploy the dumper:
   `gmf run unreal.deploy_dumper --input gameDir=<game folder>`. It needs
   `gameWrite`.
3. The game must run once with the dumper. GmfDumper starts by itself after
   the game reaches its menu, holds input while it works and closes the game
   when it is done. Do not launch the game without a `launchGame`
   authorization from the user.
4. Collect the run:
   `gmf run unreal.dump --input gameDir=<game folder> --input collect=true`.
5. Check it: `gmf run unreal.verify_dump`. It prints `PASS`, or one line per
   problem.

## Evidence

Record the run folder name, the verify result, the UE4SS release in
`gmf-install.json` and the game build.

## Pitfalls

- The framework never stops the game. A run that does not end is reported,
  and the user closes the game.
- A run is complete only when its folder holds `run_complete.json`.
- Never commit dump output.
