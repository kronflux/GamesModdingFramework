---
name: unreal-ue4ss-lua
description: Use when writing, hooking, installing or deploying a UE4SS Lua mod for an Unreal Engine game.
operations: [unreal.setup_ue4ss, unreal.ue4ss_settings, unreal.scaffold, unreal.deploy, unreal.validate, unreal.lua_check]
knowledge: [unreal.ue4ss.lua, unreal.ue4ss.lua.hooking, unreal.ue4ss.install]
---

# UE4SS Lua mods

This skill routes a Lua mod from UE4SS install to deploy. API detail, hook rules
and install layout are in the knowledge notes.

## Steps

1. Confirm the UE version, the shipping executable and the UE4SS state in
   `gmf.profile.json`.
2. If UE4SS is absent or unverified read `gmf knowledge show unreal.ue4ss.install`,
   then `gmf run unreal.setup_ue4ss --input gameDir=<game folder>`. This is a
   network, tool install and game write; it needs authorization for each.
   It also turns on the UE4SS debug console for development; on an existing
   install run `gmf run unreal.ue4ss_settings --input profile=development`.
3. Read the Lua API: `gmf knowledge show unreal.ue4ss.lua`.
4. Read hook rules before any `RegisterHook`:
   `gmf knowledge show unreal.ue4ss.lua.hooking`.
5. Scaffold: `gmf run unreal.scaffold --input name=<mod> --input type=lua-minimal`
   (or `lua-structured`).
6. Check the Lua without the game: `gmf run unreal.lua_check --input modDir=<mod folder>`.
7. Back up with `gmf run generic.backup`, deploy with
   `gmf run unreal.deploy --input modDir=<mod folder>`, then
   `gmf run unreal.validate --input modDir=<mod folder>`.
8. Take hook and object paths from a dump (load unreal-dumping), not memory.

## Evidence

Record UE4SS version, game build, hook paths with the dump they came from,
`unreal.lua_check` issues, deploy path and hash, validation result and the
`UE4SS.log` tail.

## Pitfalls

- Relative `io.open` paths resolve against `Binaries/Win64` (G1,
  `unreal.mined-gotchas`).
- `RegisterHook` never fires for functions the engine calls natively (field
  note 4); an escaping callback error can kill the process (G7).
- Do not call the engine from inside a hook body; queue it (G11).
- Hook paths come from the dump, not memory (G16); a missing function fails
  silently behind a safe-call wrapper (field note 20).
- Do not launch the game without a `launchGame` authorization. Anti-cheat is
  risk information, not a block; record it, tell the user, and continue.
