# {{name}} — In-Game Verification

There is normally no Lua interpreter on the machine a UE4SS mod is written on
(UE4SS embeds its own inside the game process), so this file — run inside the
actual game — is how you confirm the scaffold loaded and works, before you
build a real feature on top of it.

Work top to bottom; a failure early on usually explains a failure later.

## Before you start

Open `ue4ss/UE4SS-settings.ini` and enable **Hot reload** (or use the UE4SS GUI
console's "Restart All Mods" button). Then `Ctrl+R` reloads every mod without
restarting the game, which makes fixing anything below much faster.

## Step 1 — Does it load at all?

Launch the game. Open the UE4SS log (or its console window) and look for
`[{{name}}]` lines. Expect, in order (exact feature/dev-tooling lines vary
with what's wired — the scaffold ships with `FEATURE_MODULES` empty and
`systems/dev.lua` present):

```
[{{name}}] Config: ExampleFeatureEnabled=false, ExampleThreshold=10
[{{name}}] Keybinds loaded from ... (N bound).      -- or "no keys bound"
[{{name}}] Dev tooling loaded (systems/dev.lua) - DEV-ONLY, prune before release.
[{{name}}] Loaded. Run 'help' in-game for the full list of available commands.
[{{name}}] v0.1.0 | Author: {{author}}
```

**No** line containing `FATAL`.

- `FATAL: could not load module 'core.util'` (or `core.config` / `core.selftest`
  / `core.help`) means the dotted `require("core.x")` form did not resolve to
  `Scripts/core/x.lua` on this UE4SS build. Report the exact line — every other
  step below is blocked on this.
- `Dev tooling not present (systems/dev.lua missing or already pruned); skipping.`
  instead of the "Dev tooling loaded" line is expected AFTER a release-time
  prune (see the header of `Scripts/systems/dev.lua`); on a fresh scaffold it means `Scripts/systems/dev.lua`
  is missing unexpectedly — check it exists.
- `Feature '<name>' FAILED to load/register: ...` means an entry was added to
  `FEATURE_MODULES` in `main.lua` for a `Scripts/features/<name>.lua` file that
  either doesn't exist or errored in its own `M.register(ctx)` — report the
  exact error text.
- No `[{{name}}]` lines at all means the mod isn't loading — check that
  `enabled.txt` exists in the mod's folder (or, on older UE4SS installs, that
  `Mods/mods.txt` has a line enabling this mod by folder name).

## Step 2 — Run `help`

At the console (usually `~`), run:

```
help
```

**Expect** one line per registered command, at minimum:

```
[{{name}}] N available command(s):
  help                     List this mod's available console commands.
  selftest                 Run every registered in-game self-test check and report PASS/FAIL.
  devstatus                (no description provided)
  devpawn                  (no description provided)
  devdump                  (no description provided)
  devdump_objects          (no description provided)
  devdump_actors           (no description provided)
  devdump_meshes           (no description provided)
  devdump_usmap            (no description provided)
  devdump_jmap             (no description provided)
```

(`(no description provided)` is expected for anything registered through
`ctx.register_command` — the `M.register(ctx)` contract features/dev modules
follow doesn't carry a description string. The command still works and still
shows up, which is what matters for this check: every command you can run
should appear here.) If `discoverfeatures`/`discoverclass` are missing, that's
expected too — they only appear once `Scripts/features/feature-discovery.lua`
has been copied in (see the Step 2 list above).

If a command you know is registered does NOT appear here, that's a bug: every
command in this template is meant to go through `Registry.Register` (directly,
or via `ctx.register_command`), never `RegisterConsoleCommandHandler` alone —
report which command is missing.

## Step 3 — Run the self-test

```
selftest
```

**Expect:**

```
[{{name}}] selftest: PASS (1 passed, 0 failed)
```

The built-in `uehelpers` check is what's running here — it confirms the
vendored `UEHelpers` module loaded. If you see `FAIL` instead, the failure
lines printed just above it name exactly which assertion failed.

As you add real features, register a check for each one in its own module
(`SelfTest.Register("<feature>", function() ... end)` — see
`Scripts/core/selftest.lua`) so this command keeps covering the whole mod.

## Step 4 — Dev tooling (systems/dev.lua)

These are DEV/TESTING-ONLY commands — see `systems/dev.lua`'s own header and
the command list above before shipping this mod.

```
devstatus
```
**Expect** an engine version, a UE4SS version, `Keybinds enabled: false` (or
`true` if you set `KeybindsEnabled` in `config.lua`), the current config
values, and the (empty, on a fresh scaffold) list of wired feature modules.

```
devpawn
```
**Expect**, with a live pawn (in a match/level): the pawn's full name and an
`(X, Y, Z)` location line. Without a live pawn: `devpawn: no valid player pawn
yet (not in a match?).` — that's the expected fallback, not an error.

```
devdump_objects
```
**Expect** `devdump: All Objects - OK` (or a `FAILED (...)` line naming the
reason — a dump failing is still a valid, reportable result, not a crash).
`devdump` alone runs all five dumps in one go; the individual `devdump_*`
commands (`objects`/`actors`/`meshes`/`usmap`/`jmap`) let you trigger just one.

If `Scripts/features/feature-discovery.lua` was copied in and wired, also run:
```
discoverfeatures
```
**Expect** a hierarchy/function/property dump for the PlayerController, Pawn,
and (if resolvable) CharacterMovement component, ending in
`=== feature-discovery: scan complete ===`.

## Step 5 — Config persists

`Scripts/core/config.lua` only *reads* `config.lua`: this template
doesn't wire a save command by default. To check the load path works end to
end:

1. Stop the game (or disable the mod via `enabled.txt`).
2. Create a `config.lua` file next to `Scripts/` in the mod's folder:
   ```lua
   return {
       ["ExampleFeatureEnabled"] = true,
       ["ExampleThreshold"] = 42,
   }
   ```
3. Restart / re-enable and reload. The boot log line from Step 1 should now
   read `ExampleFeatureEnabled=true, ExampleThreshold=42`.
4. Delete the file (or rename `enabled.txt` back) once you're done — the
   defaults in `Config.Defaults` cover the case where it's absent.

## Step 6 — Keybinds

If you copied `keybinds.json.example` to `keybinds.json` (the mod folder that holds `Scripts/`),
press one of the bound keys (`F2` / `F3` by default) in-game and confirm a line
like:

```
[{{name}}] Keybind F2 -> toggle_example_feature
```

appears in the log. Without a `keybinds.json`, Step 1's boot log should instead
say `No keybinds.json; no keys bound.` — that's the expected fallback, not an
error. This is separate from `KeybindsEnabled` in `config.lua`, which gates
`Scripts/features/*.lua` modules' own keybinds instead (see `devstatus` in
Step 4 to check its current value).

## Step 7 — Sample feature (optional; needs a live pawn)

The sample feature only does anything when `ExampleFeatureEnabled` is `true`
(see Step 5) and only fires on `PlayerController:ClientRestart` — i.e. when a
player (re)spawns. Load into a match with the config flag set and confirm:

```
[{{name}}] Sample feature: PlayerController restarted -> ...
```

This exercises `RegisterHook` + `ExecuteInGameThread` together — the pattern
every later hook-driven feature in `Scripts/systems/` should follow.

## What to send back

For anything that failed: which step, what you saw in the log/console, and the
exact `FATAL` / `FAIL` / error text if any. `selftest`'s output is worth
including regardless of which step you were on.
