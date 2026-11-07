---
name: unreal.field-notes
title: Field notes, UE4SS in practice
description: 26 numbered findings from shipped UE4SS mods, each a documentation error, a crash and its real cause, or an approach that looked right and was not. Includes DefaultExecuteInGameThreadMethod, HookProcessConsoleExec, RegisterHook and FindAllOf traps.
engine: unreal
tags: [ue4ss, lua, field-notes, hooks, gotchas, crash, settings]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Field notes: UE4SS in practice

Each note contradicts the documentation, corrects an obvious-but-wrong approach, or records a failure that cost real time. Labels: **Verified** is checked against a real install, dump or play session. **Observed** is read in working shipped code or a log. **Inferred** is reasoned and unconfirmed; never promote an inference to a fact. The note-level `confidence` is the weakest common label; read the label on each entry.

## 1. The documentation is wrong about the game-thread settings key

**Verified** on UE4SS 3.0.1. The Lua API pages name `DefaultGameThreadExecutionMethod` (ExecuteInGameThread and EGameThreadMethod). The shipped `UE4SS-settings.ini` has no such key; it has:

```ini
DefaultExecuteInGameThreadMethod = EngineTick
```

Editing the documented name changes nothing and reports no error. Read the key out of the installed ini before telling a user to change it.

## 2. `RegisterConsoleCommandHandler` silently depends on an ini switch

**Observed** in a mod that crashed because of it; no documentation page says so. Console command registration relies on `HookProcessConsoleExec = 1`. At `0`, handlers register without error and never fire. On at least one dedicated-server build, `1` crashed the server.

When commands do nothing and the log shows a clean load, check this switch before reading mod code. Related switches that decide which hooks exist: `HookUObjectProcessEvent`, `HookGameViewportClientTick`, `HookUStructLink`. With `HookUObjectProcessEvent = 0` there is no ProcessEvent hook, so a tick tier that wanted one falls back to `EngineTick`.

## 3. Two pages disagree about `IterateGameDirectories`; `Game` is right

**Verified** on 3.0.1 in a UE 5.6 game. `lua-api.md` gives the root key `Game`; `iterategamedirectories.md` gives `<Game Name>`. On 3.0.1 it is the literal `Game`, whatever the game is called (`IterateGameDirectories().Game.Binaries.Win64`). Still treat the table as untrusted: index defensively and skip keys beginning `__` (`__name`, `__absolute_path`), which are UE4SS metadata. A directory node's absolute path is `__absolute_path`.

## 4. `RegisterHook` never fires for functions the engine calls natively

**Observed**, recorded against UE4SS issue #626. `RegisterHook` returns success and the hook never runs when the `UFunction` is invoked from native code rather than the script VM. Nothing in the return value or log distinguishes this from a working hook whose function is not called.

- A hook that registers but never fires is not necessarily misnamed. Confirm the function is script-invoked first.
- `RegisterHook` needs the `UFunction` in memory at registration time and cannot be retried except by tearing the feature down and enabling it again.
- Where a hook cannot fire, poll the property on a timed loop. Prefer about 20 Hz (`LoopInGameThreadWithDelay(50, ...)`) over per-frame: state-holding features (god mode, weather hold) are not perceptibly worse, and a per-frame `FindAllOf` sweep is expensive, especially with `bUseUObjectArrayCache = false`. Reserve per-frame loops for features that read input directly (flight, noclip).

## 5. `FindAllOf` returns actors from worlds nobody is playing in

**Verified** against an object dump of a UE 5.6 game with about twenty `UWorld` objects loaded and one running gameplay; `FindAllOf` on a vehicle class returned eight instances for a one-vehicle session. The live world is the only one holding a GameMode, a GameState and a player controller. In order of preference:

1. Walk from a world-scoped singleton. A `UWorldSubsystem` has one instance per running world. Likewise prefer a static `FindLevel<Thing>(WorldContextObject)` accessor, or a reference cached on the local pawn or controller, over a global class scan.
2. Compare `candidate:GetWorld()` with the local controller's world. **Inferred caveat:** it is not established whether UE4SS implements `GetWorld()` virtually or by walking outers, so for an actor in a streamed sublevel the two may differ. Test once per game.
3. Do not match on level name; a sublevel actor's outer path names the sublevel, not the map.

By operation:

- **Reading** the first result can describe a menu or lobby object. Always filter.
- **Calling a function with side effects** on an inert world's actor can reach a null world or subsystem. Always filter. (**Inferred**.)
- **Writing a plain property** to every instance is usually harmless, since inert copies never tick.

## 6. Host detection: three states, GameMode first, fail open

**Observed** in a working mod. Signals, strongest first:

1. **A GameMode exists in this process.** `AGameModeBase` and subclasses spawn only on the server, so if one resolves, this process is the host. A structural fact, not a replicated value.
2. **`localPC:HasAuthority()`**, the engine's role check on the local controller.
3. **The game's own "is server" boolean**, as a corroborating hint only.

Avoid two failures:

- **Do not trust the game's boolean alone.** One mod did and told a real host "not host" for every gated command; a property the server pushes to clients may never be set on the host's own copy.
- **Distinguish "not host" from "could not tell".** `UEHelpers.GetPlayerController()` can return a base `APlayerController` on which a game-specific property is nil. A two-state check scores that as "not host".

Return three states and **fail open** on unknown: run the action and warn that authority could not be confirmed. Failing closed tells a real host that every gated command did nothing. Gate by target, not by command: a self-targeted action is never gated; only actions touching another player or a shared replicated actor need the check, since writing to another player's actor as a non-host changes only your local proxy. (**Inferred** from the ownership model, consistently borne out.) Do not cache the answer; host status changes between matches.

## 7. Runtime-constructed UI costs more than it looks

**Observed** in a native C++ mod with its own panel. Building UI at runtime means hand-rolling DPI scaling and hit-testing, hard-coding font offsets and, the one that bites, **removing widgets in two phases** to avoid crashing in Slate's paint pass. Tearing a widget out while Slate may still paint it is a crash. An existing Lua menu framework already handles this. If you build your own, plan teardown first. The alternative, a precooked UI asset driven by a thin Lua shim, trades this for a cooking pipeline and a large binary rebuilt for every UI change.

## 8. Anchor every closure handed to a UE4SS loop

**Inferred**, not reproduced; the cost of being wrong is total. A Lua menu framework pins every function passed to `LoopInGameThreadWithDelay` / `ExecuteInGameThreadWithDelay` in a table, noting that UE4SS keeps only a registry reference and that if Lua collects the closure, `EngineTick` throws "Ref was not function" and removes the whole Lua tick hook. An attempt to confirm this from a real log failed: the string appeared nowhere and the tick kept running after unrelated GC messages. `[FCallbackGarbageCollector] Freed invalid callbacks!` concerns native callbacks and is **not** evidence. Treat it as cheap insurance: hold loop bodies in a table that outlives the chunk. The failure it guards against (every tick-driven feature stopping while one-shot commands keep working) is hard to diagnose because nothing reports it.

## 9. A command name is not yours

**Observed.** Two installed mods registered console command `set`; the earlier-loading one took calls with three or more arguments, with no warning. Check what else is installed before relying on a short generic name. Where a feature has an internal API, call it directly instead of dispatching its command string; another mod's handler cannot intercept that.

## 10. The Lua language server needs UE4SS's type file and still misses field typos

**Verified** with lua-language-server 3.19.2 on a 3.0.1 mod. Out of the box every UE4SS function is an undefined global. UE4SS ships `Mods/shared/Types.lua` (a `---@meta` file for the Lua API) and the dumper writes stubs for game classes to `Mods/shared/types/`. Point the server at that folder with a `.luarc.json` at the workspace root:

```json
{
  "runtime.version": "Lua 5.4",
  "workspace.library": ["<game>/Binaries/Win64/ue4ss/Mods/shared"],
  "workspace.checkThirdParty": false,
  "diagnostics.globals": ["<your mod's own global table, if any>"]
}
```

Keep it out of version control: it names one machine's install and `types/` is game-derived. Whole-mod check: `lua-language-server --check=<Scripts dir> --configpath=<abs .luarc.json> --checklevel=Warning --logpath=<dir>`; this build prints to the console.

It catches a misspelled UE4SS global (`FindAllOff`) and code after a module's `return`. It does **not** catch a misspelled field on your own module table (`U.vaild` passed), because module tables are open; cross-check `Module.name` references separately. One standing false positive: `Undefined field Log` on a console handler's `OutputDevice:Log(...)`; the calls work.

## 11. FindFirstOf's choice follows load order, so it changes between maps

**Verified** from a dump and a play session, UE 5.6. `FindFirstOf` returns the first match in object-array order, which follows world load order. On one map the running world's actor came first; on a sibling map played after the Lobby, the Lobby's copy came first and a teleport-to-van command used the Lobby van's coordinates. A lookup that passes on one map proves nothing about another. Scope to the running world (note 5) and print the chosen object's full path.

## 12. A struct returned by a UFunction call is a copy; a struct read off an object is not

**Verified** in the UE4SS source (`LuaType/LuaUObject.cpp`). Parameters live in a temporary `alloca` buffer, but the return value is pushed with `Operation::GetNonTrivialLocal`, which for a struct copies into a plain Lua table. So `local loc = actor:K2_GetActorLocation()` stays valid across later calls. A struct reached as a property (`obj.SomeStruct`) goes through `Operation::Get` and becomes a wrapper whose `start_of_struct` points into the live object; it reflects later changes and dies with it. A struct returned by a call is safe to keep across later calls; a struct read as a property is not.

## 13. Never pass a Lua string to a soft-pointer parameter; load assets with `LoadAsset`

**Verified**: three crash dumps in a UE 5.6 game, and classes loaded with `LoadAsset` then spawned. `KismetSystemLibrary:LoadClassAsset_Blocking(path)` takes a `TSoftClassPtr<UObject>`. Called with a plain path string it crashed with an access violation at `UE4SS!RC::LuaType::push_softobjectproperty+0x124` every time: no Lua error, no log line. It looked like particular items crash because only classes not yet in memory reached that branch; classes already in the level resolved through `StaticFindObject`. Dumps were read with `cdbX64.exe -z <dump> -c ".ecxr; kn 40; q"`.

Load an unloaded Blueprint class with `LoadAsset("<pkg>.BP_X")` (declared in `Types.lua`, game thread only), then `StaticFindObject("<pkg>.BP_X_C")`. Same caution for any UFunction parameter of type `TSoftObjectPtr`, `TSoftClassPtr`, `FSoftObjectPath` or `FSoftClassPath`. A class that crashes on spawn is far more often a crash in how the mod reached it than in the class.

## 14. Read a crash dump yourself: `cdbX64` ships with the Store WinDbg

**Verified** on Windows 11, no install needed. UE4SS writes `crash_<date>.dmp` beside `UE4SS.log` in the `ue4ss` folder. Store WinDbg puts `cdbX64.exe` on `PATH` via `%LOCALAPPDATA%\Microsoft\WindowsApps\`. Run it over every dump in the folder:

```bash
"$LOCALAPPDATA/Microsoft/WindowsApps/cdbX64.exe" -z "<ue4ss>/crash_<date>.dmp" -c ".ecxr; kn 40; q"
```

| Top frame | Meaning |
|---|---|
| `UE4SS!RC::LuaType::push_softobjectproperty` | A Lua value was converted to a soft object or class pointer parameter (note 13). |
| `UE4SS!RC::LuaMadeSimple::...` above `Lua::call_function` | Crash while running a Lua callback; the frame just below names what was converted or called. |
| Game module frames only | The game crashed on its own, or on state a mod left behind. |

Without symbols a name is only the nearest exported symbol below the address. A small offset (`+0x124`) is credible; a large one (`resolve_function_address_from_potential_jmp+0x139e1`) means the code is somewhere past that export and the name says nothing. Classify on the nearest frame with a small offset. The same top frame across dumps from different actions is one bug. Do not name a crash cause from the log when a dump exists: the log stops before the crash.

## 15. `UE4SS.log` is rewritten on every launch, so keep a session log of your own

**Verified**: results written only to `UE4SS.log` are lost when the game is relaunched before the log is read. UE4SS truncates `UE4SS.log` at startup. A mod tested over several launches should append result lines to a file in its mod folder, with a dated header per session and a size cap (rotate to one `.old`). Resolve the path from the mod's own folder, never a relative `io.open`, which resolves against `Binaries/Win64` (`unreal.mined-gotchas`, G1). Read that file first when the user reports a result.

## 16. Searching the object array on a timer costs frame rate; cache through `NotifyOnNewObject`

**Observed**: frame rate dropped right after four switches were turned on that each ran `FindAllOf` or `FindFirstOf` on the 20 Hz tick, about 80 full walks a second. The cached replacement is **inferred** to fix it, not confirmed in play. Both calls walk the whole `GUObjectArray` (hundreds of thousands of objects). Seed a list once, then keep it current with `NotifyOnNewObject("/Script/Module.Class", fn)` and drop entries failing `IsValid()`. A Blueprint class not loaded at start cannot be registered by class path; search for it rarely (twice a second, bounded time).

`Types.lua` declares the `NotifyOnNewObject` callback with no arguments; UE4SS passes the new object first. Write `function(...) local obj = ... end` and silence `redundant-parameter` on that line.

## 17. Never set a game's delay or minimum-duration property to 0

**Observed** twice in one UE 5.6 game: zeroing `LoadingScreenWidget.MinDuration`, `GameInstance.HostTravelDelay` and a GameMode `FallbackStartDelay` left the game stuck on a loading screen. Raising the loading minimum alone to 0.1 s did not cure it, so which value caused it is **not isolated**. The mechanism is **inferred**: a Blueprint waiting on `SetTimer(Delay)` gets no timer when the delay is 0 or less (Unreal clears a timer set to a non-positive time), so whatever it should finish never happens. Use a small positive floor (0.1 s), change one at a time and log old and new values. Ship speed-up switches off by default, with a way to turn them off that does not need the menu (console command or file value).

## 18. Being immune to damage is not being immune to the effect

**Verified** in play: god mode plus every damage multiplier at 0 stopped environmental damage, but the player was still thrown back and dropped held items. Adding the stun-immunity flag and undoing any knock-down fixed it. A hit has several consequences on separate paths: damage, stun or ragdoll, item drop, screen effect; each damage flag blocks only damage. When protection "does not work", ask which consequence still happens, then hook every candidate function on that path and log which fire on a real hit (a hook-probe helper). Here `hit seen, Client_OnHit fired` named the path in one test. Look for a dedicated flag first (`bIsStunInvulnerable`) and keep a polled undo (cancel the ragdoll when `bIsRagdolling` turns true) as fallback for hooks that never fire (note 4).

## 19. Apply a status effect through the game's own effect asset

**Verified** in play: "set on fire" worked by adding the game's fire-damage status effect asset via `Server_AddStatusEffect(asset)` on the player's attributes component, and ended early with `Server_RemoveMoodlet(asset)`. Modern Unreal games express burning, poison, stun and buffs as data assets (moodlet, GameplayEffect, status-effect row) applied by one function, not as a character boolean. Search the object dump for the asset (`grep -i "moodlet\|effect" UE4SS_ObjectDump.txt`) before hunting a flag; the asset brings damage, visuals and timeout. If `StaticFindObject` returns nothing, load it with `LoadAsset` (note 13).

## 20. A function name not in this build's dump fails silently behind a safe-call wrapper

**Verified**: a mod called `Server_ForceItemTransformReplication` after every item move and printed "the server was asked to accept the moves", but the function is not in that game's header dump. The `pcall`-based `call(obj, name, ...)` helper returned false and the message reported a request that never ran. Find every UFunction a feature depends on in the header dump before shipping (`grep -n "FunctionName" CXXHeaderDump/*.hpp`). A safe-call helper must make "no such function" a distinct result, and no success message may come from a path that does not check it. Names copied from another mod, an older version or memory are the usual source.

## 21. The game's own flag can report success while the visible result is missing

**Observed**: calling `Client_TogglePerspective(true, pawn)` locally made `IsInFirstPersonMode()` read false, yet the camera only moved "a couple pixels back"; the spring arm's `TargetArmLength` stayed near zero. Lengthening the arm is the **inferred** fix, not confirmed. A read-back proves the state changed, not that the player sees it. Log the state, then ask the user what they see. For a view change check `USpringArmComponent.TargetArmLength` and mesh visibility as well as the mode flag.

## 22. Replicated progress flags can lag their values; treat value at target as done

**Observed**: after completing objectives, they read `CurrentValue 7`, `TargetValue 7`, `bIsCompleted false`, while the owning quest read `bIsCompleted true`. Test `bIsCompleted == true or (TargetValue > 0 and CurrentValue >= TargetValue)`. When a struct inside a replicated array disagrees with its owner, trust the value and the owner. Check the data's own category flags (`QuestDetails.bIsOptional`) before a "complete all": a player may not want required tasks finished together with optional objectives.

## 23. Re-applying saved settings after a level change must wait for the component, not the pawn

**Observed**: a "keep this setting" watcher re-ran saved commands three seconds after a new world appeared and the pawn existed, and logged `no live object for resolver 'attributes' | dmgelec: nothing changed`; the pawn existed before its attributes component. Gate each re-apply on the object it writes to and retry (or re-apply on first sight of that object's key) until it exists. One fixed delay after the pawn appears is not enough.

## 24. A static UFunction is called on the class default object, with a world-context argument

**Verified** in play: `AExampleVehicle::FindLevelVehicle(const UObject* WorldContextObject)`, called as `StaticFindObject("/Script/<Module>.Default__ExampleVehicle"):FindLevelExampleVehicle(pc)`, returned the running world's van where `FindFirstOf("ExampleVehicle")` returned one from another loaded world and teleported the player wrongly. A `static` function in the UHT header (or one with a `WorldContextObject` first parameter) is called on the `Default__<Class>` object. Passing the local controller as world context scopes the result to the running world (note 5). Prefer such a finder over `FindAllOf`.

## 25. Iterating `TArray` and `TMap` properties: `ForEach` with `:get()`, guarded

**Verified** in play on a `TMap<EQuest, ABaseQuest*>` and a `TArray<FObjectiveInfo>`; struct element fields were read by plain indexing (`elem.CurrentValue`).

```lua
-- Calls fn(value) for each element of a Lua table, TArray or TMap (values only).
local function each(container, fn)
    if container == nil then return end
    if type(container) == "table" then
        for _, v in ipairs(container) do fn(v) end
        return
    end
    pcall(function()
        container:ForEach(function(a, b)
            local raw = (b ~= nil) and b or a  -- TMap: key, value. TArray: index, element.
            local ok, inner = pcall(function() return raw:get() end)
            fn(ok and inner ~= nil and inner or raw)
        end)
    end)
end
```

Elements arrive wrapped and need `:get()`; some builds hand plain values, hence the fallback. A UFunction returning `TArray<...>` goes through the same helper.

## 26. The menu framework ue4ss-ModMenu: rules learned by checking

**Verified** against the source and in play, ue4ss-ModMenu v1.4.0 (MIT, https://github.com/mattdavida/ue4ss-ModMenu). Full notes: `unreal.modmenu`.

- A `dropdown` with an empty `options` array fails validation and the whole section does not register. Seed a placeholder option with value `""`.
- Replacing the options of a non-searchable dropdown rebuilds the panel; mark often-refreshed lists `searchable = true`.
- A `row` holds only `button`, `checkbox`, `label`, `number` and `textinput` children.
- One shell per mod; an open shell takes the mouse and the GameAndUI input mode. A second passive panel (stats overlay) must be a separate HitTestInvisible widget built by the mod.
- `ModMenu.Init` can be called again to change size and theme; re-`Register` a section to rebuild it.
- Bind an escape key with `RegisterKeyBind` before the menu is created: it closes the shell first, then restores game input. In a game that can trap input focus the console is what stops working, so the escape cannot depend on it.
