---
name: unity-bepinex
description: Use when a Unity game runs BepInEx 5 or 6 and you must scaffold, build, deploy, validate or package a plugin for it.
operations: [unity.scaffold, unity.build, unity.deploy, unity.validate, unity.package, unity.remove_mod]
knowledge: [unity.bepinex, unity.bepinex.lifecycle]
---

# Unity BepInEx plugins

This skill routes a BepInEx plugin job from scaffold to package. The loader and
backend come from the profile; the detail lives in the knowledge notes, not here.

## Steps

1. Confirm loader, backend and target framework in `gmf.profile.json`. If they
   are unknown, load gmf-investigate first.
2. Read how to recognize the install and where plugins go:
   `gmf knowledge show unity.bepinex`.
3. Read attributes, init order, ConfigEntry and logging before writing code:
   `gmf knowledge show unity.bepinex.lifecycle`.
4. Scaffold the template that matches the profile:
   `gmf run unity.scaffold --input name=<mod> --input loader=<bepinex5|bepinex6|melonloader>`.
   Template ids are in `gmf catalog --json` (unity-bepinex5, unity-bepinex6-mono,
   unity-bepinex6-il2cpp).
5. Build: `gmf run unity.build --input modDir=<mod folder>`. Read the exit code
   and log tail.
6. Back up any file you will replace with `gmf run generic.backup`, then deploy:
   `gmf run unity.deploy --input modDir=<mod folder>`. Deploy is a game write
   and needs the plan's `gameWrite` authorization.
7. Check the result: `gmf run unity.validate --input modDir=<mod folder>`.
8. Package for release: `gmf run unity.package --input modDir=<mod folder>`.
9. For patch code load unity-harmony; for IL2CPP load unity-il2cpp.
10. To take a mod out of the game, run
    `gmf run unity.remove_mod --input name=<plugin folder>`. It backs up every
    file first and needs a `gameWrite` authorization.

## Evidence

Record the loader and version, target framework, build command and exit code,
deployed file hash, validation result and the BepInEx log tail. Never commit a
game assembly or an interop folder.

## Pitfalls

- BepInEx 5 and 6 differ in plugin base class and folder layout
  (`unity.bepinex`). A plugin built for 5 does not load on 6.
- Plugin GUID, name and version attributes must be unique and stable
  (`unity.bepinex.lifecycle`).
- Do not launch the game to test without a `launchGame` authorization; read the
  log from the last run the user made instead.
- Anti-cheat is risk information, not a block. Record any marker, tell the user
  what a deploy might trigger, and continue.
