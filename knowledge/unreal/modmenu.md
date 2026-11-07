---
name: unreal.modmenu
title: Building an in-game mod menu on ue4ss-ModMenu
description: How to build a mouse-driven in-game menu on UE4SS 3.0.1 with the third-party ue4ss-ModMenu framework, its API, undocumented rules and working patterns.
engine: unreal
tags: [ue4ss, lua, modmenu, ui, umg, config, keybinds]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Building an in-game mod menu on ue4ss-ModMenu

A mouse-driven menu on top of an existing console-command mod (UE 5.6, UE4SS 3.0.1). Rules marked **verified** were checked in play or against the framework source; the rest are marked.

## Getting the framework

ue4ss-ModMenu is third-party and MIT-licensed: https://github.com/mattdavida/ue4ss-ModMenu. It builds stock `/Script/UMG.*` widgets through `StaticConstructObject` using only stock UE4SS globals, so it is not game-specific.

1. Clone it and run `npm run bundle`; the output is one generated file, `ModMenu.lua`.
2. Install it as `<game>/.../ue4ss/Mods/shared/ModMenu/ModMenu.lua`, with its `LICENSE`.
3. It needs `Mods/shared/UEHelpers/`, which ships with UE4SS.
4. Hosts load it with `require("ModMenu.ModMenu")`.

Build from a checkout at a known commit rather than copying a stray prebuilt bundle: two bundles can differ by dozens of hunks. The optional settings store (`ModMenu.ConfigManager`) exists only in newer bundles.

## The API in one screen

```lua
local ModMenu = require("ModMenu.ModMenu")

ModMenu.Init({                       -- safe to call again to change any option
    title = "MyMenu", instanceId = "MyMenu",
    key = Key.F6, keyHint = "F6",    -- toggle key
    consoleCommand = "mymenu",       -- opens it without the key
    dock = "right",                  -- left | right | top | bottom
    theme = "dark", colors = { ... },-- colour tokens, e.g. panelBg, textAccent
    tabs = { "Player", "World", "Settings" },
    fontScale = 0.8, widthFrac = 0.26,
    ignoreLook = true,               -- mouse-look games: stop the camera spinning
})

ModMenu.Register({
    id = "Player", title = "Protection", tab = "Player",
    collapsible = true, collapsed = false,
    items = {
        { type = "row", items = {
            { type = "label", label = "God mode" },
            { type = "button", id = "god_on", label = "On", onClick = function() ... end },
        } },
        { type = "dropdown", id = "who", label = "Player", searchable = true,
          options = { { label = "(press Refresh)", value = "" } }, allowEmpty = true },
        { type = "number", id = "speed", label = "Speed", default = 1 },
        { type = "button", id = "reset", label = "Reset", variant = "warning",
          confirm = { title = "Are you sure?", message = "...", confirmLabel = "Do it" },
          onClick = function() ... end },
        { type = "fold", id = "more", label = "More", collapsed = true, items = { ... } },
        { type = "label", id = "status", label = "" },
        { type = "separator" },
    },
})

ModMenu.Get(sectionId, itemId)              -- current value
ModMenu.Set(sectionId, itemId, value)
ModMenu.SetLabel(sectionId, itemId, text)   -- the usual way to show a result
ModMenu.SetOptions(sectionId, itemId, options, selectedValue)
ModMenu.SetButtonLabel / SetButtonEnabled / SetButtonVariant / SetButtonActive
ModMenu.Close()
ModMenu.ConfigManager.Init({ id = "MyMod", defaults = { ... } })  -- newer bundles only
```

## Rules learned by checking

- **Verified:** a `dropdown` with an empty `options` array fails validation and the whole section does not register. Seed a placeholder with value `""` and read `""` as "nothing picked".
- **Verified (source):** replacing the options of a non-searchable dropdown rebuilds the panel. Lists refreshed while open should be `searchable = true`.
- **Verified (source):** a `row` takes only `button`, `checkbox`, `label`, `number` and `textinput` children. Three buttons fit a row in a docked panel at 0.26 width.
- **Verified:** one shell per mod (each mod calling `Init` gets its own panel and hotkey); an open shell takes the mouse cursor and the GameAndUI input mode. A second panel that must not touch input (stats overlay) must be a separate widget built by the mod with visibility HitTestInvisible.
- **Verified:** `Init` can be called again. To change text size or width at runtime, store the values, re-call `Init`, re-`Register` the visible sections. There is no drag-to-resize; size steppers on a Settings tab are the substitute.
- **Observed:** a `number` field is awkward to type into in game; `[-] [field] [+]` steppers in a `row` worked better.
- **Observed (store):** `ConfigManager` writes `<mod>/config.json`, merges defaults, keeps unknown keys, autosaves on `Set`, and refuses to save over a file it failed to parse. It is host-owned: no widget saves anything by itself.
- **Observed:** checkboxes show a state the menu believes. When the command does not report state back, use On and Off buttons so the panel never shows a wrong state.

## Patterns that worked

**One implementation for console and menu.** The menu held no feature logic. Each control ran an existing console command through the mod's command registry, showed the command's own output in the section's `status` label and wrote it to the session log (`unreal.field-notes` 15). Menu and console cannot drift. To get the registry, record handlers as they register:

```lua
-- core/commands.lua: replace the global with a recorder before any feature registers.
local REGISTRY, real = {}, RegisterConsoleCommandHandler
RegisterConsoleCommandHandler = function(name, handler)
    REGISTRY[name:lower()] = handler
    return real(name, handler)
end

-- Run "name arg1 arg2" straight through the handler, capturing its output.
local function runOne(text)
    local words = {}
    for w in text:gmatch("%S+") do words[#words + 1] = w end
    local h = REGISTRY[(words[1] or ""):lower()]
    if h == nil then return false, "unknown command" end
    local lines = {}
    local out = { Log = function(_, s) lines[#lines + 1] = tostring(s) end }
    local ok, err = pcall(h, text, { table.unpack(words, 2) }, out)
    return ok, ok and table.concat(lines, "\n") or tostring(err)
end
```

The handler is called directly, not through the game console, so another mod registering the same name (field note 9) is never reached.

**An escape key bound first.** Before `Init`, bind a key with `RegisterKeyBind` that closes the shell, then restores game input (GameOnly, cursor hidden, any stuck widget released). Close first: the other order resets a state the open shell takes straight back. In a game that can trap input focus the console stops working, so the escape must not depend on it.

**Per-setting Keep, never a global auto-save.** Each switch and number has a Keep toggle storing its command; a watcher re-runs kept commands after each level change once the objects they write to exist (field note 23). A global "save everything" made values a player was only trying out permanent.

**Tabs by what a control acts on.** A workable layout: Player, Items, World, Settings, one tab per kind of target. Features still being tested go in a collapsed "More (testing)" section on the tab they act on, not a "known issues" tab. Generate controls from data where the mod has data (a tunables table becomes steppers grouped by object) but place each group on a tab by hand. Propose the whole map, with previews, before moving anything: partial reshuffles confuse users.

**Every load step under `pcall`.** Load the menu last in `main.lua` under `pcall` and register each section under its own `pcall`, so a broken section costs only itself and the console mod keeps working if the menu fails.
