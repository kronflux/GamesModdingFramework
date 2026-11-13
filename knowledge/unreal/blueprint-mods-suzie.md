---
name: unreal.blueprint-mods.suzie
title: Blueprint mods against game classes with Suzie and the jmap
description: How the .jmap file from a GmfDumper run lets the Unreal editor see a game's classes, so a Blueprint mod can be written against them without recreating C++ headers.
engine: unreal
tags: [blueprint, suzie, jmap, editor, logicmods, pak]
confidence: inferred
sources: [trumank/Suzie README (states it was tested on UE 5.3 to 5.6), UE4SS jmap dumper documentation, tool survey of 2026-11-12 (web reading only; not run by gmf)]
---

# Blueprint mods with Suzie

A Blueprint mod is built in the Unreal editor and loaded through the
`LogicMods` folder (`unreal.pak-blueprint`). The editor must know the game's
classes before a Blueprint can inherit from them or call them.

Suzie is an editor plugin (MIT) that creates those classes at editor start from
a `.jmap` file: the reflection data UE4SS writes with its jmap dumper. A
GmfDumper run writes one, and `unreal.dump` with `collect=true` copies the run
into `dumps/unreal/runs/<run>/`.

This note is from the Suzie README, read on 2026-11-12. gmf has not run it.

## Steps

1. Run the first dump (`gmf skill show unreal-first-dump`) and find the
   `.jmap` file in the collected run.
2. Create an editor project with the same engine version as the game.
3. Add the Suzie plugin to the project and give it the `.jmap`, as its README
   describes.
4. Open the editor. The game's classes appear and can be used as parents and
   in function calls.
5. Cook and package the Blueprint mod and deploy it with `unreal.deploy` as a
   pak mod (`unreal.pak-blueprint`).

## Limits

- The classes are stand-ins: they carry properties and function signatures,
  not the game's code. A call runs the real function only inside the game.
- The README names UE 5.3 to 5.6 as tested. Check it for other versions.
- An older route, generating a C++ project from headers, is not maintained for
  current engine versions.
