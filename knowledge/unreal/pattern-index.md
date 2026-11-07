---
name: unreal.pattern-index
title: Pattern index, task to known UE4SS Lua pattern
description: A task-to-pattern lookup for UE4SS Lua mods (console commands, menus, HUD, ESP, keybinds, spawning, weather, actor iteration, config, safe hooking) naming the API calls to search for.
engine: unreal
tags: [ue4ss, lua, patterns, index, cookbook]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Pattern index: task to known pattern

Check `unreal.cookbook.basic` first; it holds self-contained recipes for the same problem space. Use this index only for a task the cookbook does not cover. Each entry describes a pattern seen in real shipped UE4SS Lua mods, which are an optional external corpus, not bundled. If you have such mods, search them for the named API, read the cited area and verify before copying. Nothing here is a required read.

## Console-command mod

Wrap `RegisterConsoleCommandHandler` in `pcall` plus a debounce guard (last command name and time) so a spammed command cannot double-fire or crash the mod. For many commands, a commands-manager module with a command table, aliases and parameter validation (`CreateCommand`, `MapCommand`, `GetCommandByAlias`).

## Cheat menu / mod menu (GUI)

A shared in-game UMG menu-shell module with an `Init(...)` / `Register({...})` contract (checkboxes, buttons, dropdowns, tabs, docking), widget-construction and registry submodules, and a minimal host example. See `unreal.modmenu`.

## HUD toggle / on-screen text

Find the HUD widget instance and flip a bool:

```lua
RegisterKeyBind(Key.F9, {}, function()
    local hud = FindFirstOf("<HUDClassName>")
    if hud:IsValid() then hud.bShowHUD = not hud.bShowHUD end
end)
```

## ESP / overlay / draw

Hook the engine HUD's draw event (`RegisterHook("/Script/Engine.HUD:ReceiveDrawHUD", ...)`), project world locations with `self:Project(actorLoc)` and draw distance-gated labels with `self:DrawText(text, color, screenPos.X, screenPos.Y, font, 1.0, false)` inside a `pcall`.

## Keybinds / hotkeys

A flat table of `RegisterKeyBind(<virtual-key-code>, function() ... end)` calls, one per feature module, keeps the hotkey map in one readable place while behaviour lives in separate files.

## Item spawner / give item

UE4SS Lua has no generic `SpawnActor`. A common workaround finds an existing instance of the Blueprint class with `FindAllOf(variant)` (trying numbered class-name variants) and relocates it in front of the player with `target:K2_SetActorLocation(...)`.

## World / weather / time manipulation

Read all weather-event row names off the game's own weather-event data table, cache them, and drive weather changes through that table rather than hand-rolled weather actors.

## Actor iteration / manipulation

`local instances = FindAllOf(shortClassName)`, iterating with `:IsValid()` checks before touching each actor. Mind world scoping (`unreal.field-notes` 5).

## Config load / save

Resolve a JSON path under the game directory, `io.open` it, fall back to a default-config constructor when missing, `pcall(json.decode, content)` and merge over defaults so missing keys never nil-error. Save mirrors it (`json.encode`, `io.open(path, "w")`). Resolve the path from the mod folder (`unreal.mined-gotchas` G1).

## Safe hooking (RegisterHook + ExecuteInGameThread)

A hooks-manager helper wraps `RegisterHook` in `pcall(RegisterHook, functionName, preCallback, postCallback)`, records the returned pre and post ids on a hook-info object and resets cleanly on failure, so a bad hook path cannot crash mod init. `ExecuteInGameThread` is required whenever a hook callback or async code touches UObjects outside the game thread's own call stack.
