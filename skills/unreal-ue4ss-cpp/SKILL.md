---
name: unreal-ue4ss-cpp
description: Use when writing or building a native C++ mod against the UE4SS SDK for an Unreal Engine game.
operations: [unreal.scaffold, unreal.build, unreal.deploy, unreal.validate]
knowledge: [unreal.ue4ss.cpp]
---

# UE4SS C++ mods

This skill routes a native mod: a class deriving from the UE4SS user-mod base,
built against an SDK version that matches the installed UE4SS.

## Steps

1. Confirm the UE4SS version in the profile. Choose C++ only when Lua cannot do
   the job; otherwise load unreal-ue4ss-lua.
2. Read the lifecycle, exports and build setup:
   `gmf knowledge show unreal.ue4ss.cpp`.
3. Scaffold: `gmf run unreal.scaffold --input name=<mod> --input type=cpp`.
4. Build: `gmf run unreal.build --input modDir=<mod folder>`. Read the exit
   code and the first compiler error.
5. Back up with `gmf run generic.backup`, deploy the DLL and its metadata:
   `gmf run unreal.deploy --input modDir=<mod folder>`. This is a game write and
   needs `gameWrite` authorization.
6. Check: `gmf run unreal.validate --input modDir=<mod folder>`.
7. Resolve targets by UFunction path or signature, never a fixed address (load
   unreal-aob when a signature is needed).

## Evidence

Record the SDK and UE4SS versions, compiler and build exit code, DLL hash,
deploy path, validation result and the `UE4SS.log` tail.

## Pitfalls

- The SDK version must match the installed UE4SS or the DLL fails to load
  (`unreal.ue4ss.cpp`).
- The mod needs the start and uninstall exports and a companion enabled file
  (`unreal.ue4ss.cpp`).
- UI hazards carry over from Lua: do not spawn duplicate widgets (G38) or cache
  UObjects across a world reload (G40) (`unreal.mined-gotchas`).
- Do not launch the game without a `launchGame` authorization. Anti-cheat is
  risk information, not a block; record it and continue.
