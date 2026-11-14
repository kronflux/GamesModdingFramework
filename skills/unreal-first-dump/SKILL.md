---
name: unreal-first-dump
description: Use as the first step on an Unreal Engine game, before any mod work, to install UE4SS, run GmfDumper once and collect a verified dump of the game.
operations: [unreal.setup_ue4ss, unreal.deploy_dumper, unreal.run_dump, unreal.dump, unreal.verify_dump, unreal.read_containers, unreal.build_docs]
knowledge: [unreal.dumps, unreal.dumps.artifacts, unreal.gamedocs, unreal.gmfdumper.native]
---

# First dump of an Unreal game

One run of GmfDumper records how the game works: classes, structs, enums,
data tables, class defaults, Blueprint bytecode, every level's actors and the
asset list. `unreal.build_docs` turns the run into Markdown pages. Later mod
work reads those pages instead of guessing.

## Steps

1. Install UE4SS when it is missing:
   `gmf run unreal.setup_ue4ss --input gameDir=<game folder>`. It needs
   `toolInstall` and `gameWrite` authorizations and records the installed
   release in `gmf-install.json`.
2. Deploy the dumper:
   `gmf run unreal.deploy_dumper --input gameDir=<game folder>`. It needs
   `gameWrite`; the native part also needs `toolInstall`. Read `native` in the
   result (`gmf knowledge show unreal.gmfdumper.native`):
   - `installed`: the C++ part matches UE4SS. Continue.
   - `mismatch`: it was built for another UE4SS release. Run step 1 again.
   - `unknown`: gmf did not install UE4SS. Run step 1.
   - `unavailable`: the download failed. Check the network.
   - `not_authorized`: no `toolInstall`. Ask the user, then deploy again.
3. Ask the user for permission to launch the game. Without a `launchGame`
   authorization, stop here.
4. Run the dump: `gmf run unreal.run_dump --input gameDir=<game folder>`. It
   needs `gameWrite` and `launchGame`, and refuses when the game is running.
   Act on `status`:
   - `complete`: the run is collected into `dumps/unreal/runs/`. Go to step 5.
   - `empty`: the mod produced nothing. Read `manifestReasons`.
   - `crashed`: a new crash dump exists. Read `crashDump` and `UE4SS.log`.
   - `exited`: the game closed early. Read `logTail`.
   - `running`: the wait ended first. When the game closes, run
     `gmf run unreal.dump --input gameDir=<game folder> --input collect=true`.
5. Check it: `gmf run unreal.verify_dump`. It prints `PASS`, or one line per
   problem.
6. Read the text files inside the paks:
   `gmf run unreal.read_containers --input gameDir=<game folder>`.
7. Build the docs: `gmf run unreal.build_docs`. Read `gamedocs/overview.md`
   first (`gmf knowledge show unreal.gamedocs`). The console variable pages
   read the game executable named by the run or the profile; pass
   `--input gameExe=<path>` when neither has it.

Cleanup is automatic. `unreal.run_dump` removes the run from `<ue4ss>/Dumps`
once the workspace copy verifies (`--input removeGameCopy=false` keeps it), then
waits for the game to close and removes the one-time GmfDumper mod, backed up
first (`--input removeDumper=false` keeps it). Deploy it again for the next dump.
`unreal.build_docs` removes the run files its pages distilled, when the run
verified and no section is missing (`--input prune=false` keeps them). Tool
inputs stay: usmap and jmap, C++ headers, Lua types, the Blueprint SDK, the
object dump, the hook list and the name table. A pruned run records
`pruned.json` and cannot build docs again; dump again to rebuild them.

A user may start the game themselves instead of steps 3 and 4. GmfDumper runs
by itself once the game reaches its menu. Then run the `collect=true` command
from step 4.

## Evidence

Record the run folder name, the verify result, the UE4SS release in
`gmf-install.json`, the `native` value and the game build.

## Pitfalls

- The framework never stops the game. GmfDumper closes it when the run ends;
  if it does not, the user closes it.
- A run is complete only when its folder holds `run_complete.json`.
- Dump and docs output is game content. Never commit it.
