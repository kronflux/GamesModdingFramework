---
name: unreal.ue4ss.lua
title: UE4SS Lua mod layout
description: Write a UE4SS Lua mod with a load entry, hooks and console commands in the folder layout UE4SS discovers.
engine: unreal
tags: [ue4ss, lua, events, hooks, mods]
confidence: verified
sources: [UE4SS documentation, RE-UE4SS GitHub repository, earlier Unreal modding framework notes]
---

# UE4SS Lua mod layout

The full API map and hooking checklist are in `unreal.ue4ss.lua.hooking`. Read `unreal.field-notes` and `unreal.mined-gotchas` before writing hooks, object scans or console commands.

UE4SS loads Lua mods from its `Mods/` folder next to the shipping executable.

## Layout

```
ue4ss/Mods/MyMod/
  enabled.txt
  scripts/main.lua
```

- `enabled.txt` may be empty. Without it, and without an entry in `mods.txt`, UE4SS skips the folder.
- `scripts/main.lua` is the default entry. A `Scripts` folder with a different
  case is not found on every platform.
- Newer UE4SS builds read a `mod.json` for metadata and key binds. It is
  optional; a minimal mod needs only the two files above.

## Lua entry points

- `RegisterHook("/Script/Engine.PlayerController:ClientRestart", callback)` hooks
  a function on a UFunction path.
- `RegisterKeyBind(Key, callback)` binds a key.
- `RegisterConsoleCommandHandler`, `RegisterConsoleCommandGlobalHandler` add
  commands.
- `LoopAsync` or `ExecuteWithDelay` runs work after the game has loaded.
- `StaticFindObject` and `FindFirstOf` resolve objects at runtime.

## Evidence

Record the UE4SS version, the game build and the object paths a mod resolves.
A mod that works on one game build can fail after an update because a UFunction
path changed.

## Pitfalls

- Do not hook during module load before the object tree exists. Wait for a
  load event or a player controller.
- A missing `enabled.txt` looks like a broken script. Check it first.
- Lua errors appear in `UE4SS.log`. Read the log tail before changing code.
- The game must be launched by the user. The framework does not launch a game to
  test a mod unless the plan authorizes `launchGame`.
