---
name: unreal-cookbook
description: Use when writing a concrete UE4SS Lua feature such as noclip, god mode, currency, item spawning, or a mod menu from a proven pattern.
operations: [unreal.scaffold, unreal.lua_check, unreal.deploy]
knowledge: [unreal.cookbook.basic, unreal.cookbook.advanced, unreal.modmenu]
---

# Unreal cookbook

This skill routes feature work to a proven recipe instead of guessing. Recipes
show a shape; the target names still come from a dump.

## Steps

1. Match the request to a recipe: `gmf knowledge show unreal.cookbook.basic` for
   common cheats, `gmf knowledge show unreal.cookbook.advanced` for harder ones.
2. For a settings or cheat menu read `gmf knowledge show unreal.modmenu`.
3. Scaffold with the feature and helper templates:
   `gmf run unreal.scaffold --input name=<mod> --input type=lua-structured --input features=<feature names> --input helpers=<helper names>`.
   Feature and helper ids are in `gmf catalog --json` (unreal-features,
   unreal-helpers). An unknown name fails with `GMF-E-TEMPLATE-001`.
4. Replace the recipe's names with ones from the dump (load unreal-object-model).
5. Check: `gmf run unreal.lua_check --input modDir=<mod folder>`.
6. Back up with `gmf run generic.backup`, then deploy
   `gmf run unreal.deploy --input modDir=<mod folder>`. Deploy is a game write and
   needs `gameWrite` authorization.
7. For more patterns by intent load unreal-reference-patterns.

## Evidence

Record the recipe used, the dump names that replaced its placeholders, the
`unreal.lua_check` result and the deploy path and hash.

## Pitfalls

- Engine and game code silently revert one-shot writes (G20); a value often
  needs its sibling override flag (G25).
- Never set a game's delay or minimum-duration property to 0 (field note 17);
  immunity to damage is not immunity to its effect (field note 18).
- Spawning an arbitrary Blueprint class can crash (G35).
- A command name is not yours (field note 9). Cite `unreal.mined-gotchas` and
  `unreal.field-notes` ids when you record a decision.
- Do not launch the game without a `launchGame` authorization. Anti-cheat is
  risk information, not a block; for multiplayer features say so and continue.
