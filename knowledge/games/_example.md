---
name: games.example
title: Example Game
description: A synthetic example of a per-game note; not a real game.
engine: core
tags: [game, example]
confidence: inferred
game: Example Game
store: steam
appId: 0
loader: bepinex5
antiCheat: none
verified: never
sources: [https://example.invalid/synthetic-example]
---

# Example Game

This is a synthetic note that shows the layout. "Example Game" does not exist and every value is a placeholder.

## Detection

- The profile reported the Mono backend because a managed assembly folder was present. (Observed.)
- The loader folder and its core assembly were found beside the executable. (Observed.)

## Loader

- BepInEx 5 loads plugins from its plugins folder. (Inferred, not run against a real install.)

## Anti-cheat

- None found in the install folder. This records absence of evidence, not a guarantee.

## Known targets

- `PlayerController.TakeDamage`, a method name used only as an example of how to record a target as a name.

## Pitfalls

- Replace every value before relying on a copy of this file, and set `verified` to the date of a real check.

See `unity.bepinex` and `core.games`.
