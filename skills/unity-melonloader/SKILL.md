---
name: unity-melonloader
description: Use when a Unity game runs MelonLoader and you must scaffold, build, deploy, validate or package a Melon mod for it.
operations: [unity.scaffold, unity.build, unity.deploy, unity.validate, unity.package]
knowledge: [unity.melonloader]
---

# Unity MelonLoader mods

This skill routes a MelonLoader mod job. MelonLoader is one loader for Mono and
IL2CPP games, so the backend decides the target framework and the interop need.

## Steps

1. Confirm the loader, backend and target framework in `gmf.profile.json`.
2. Read install recognition, the MelonMod base class, attributes and lifecycle:
   `gmf knowledge show unity.melonloader`.
3. Scaffold: `gmf run unity.scaffold --input name=<mod> --input loader=melonloader`.
4. Build: `gmf run unity.build --input modDir=<mod folder>`. Read the exit code
   and the first error line.
5. Back up with `gmf run generic.backup`, then deploy to the Mods folder:
   `gmf run unity.deploy --input modDir=<mod folder>`. This is a game write and
   needs `gameWrite` authorization.
6. Check: `gmf run unity.validate --input modDir=<mod folder>`.
7. Package: `gmf run unity.package --input modDir=<mod folder>`.
8. For patches load unity-harmony. For an IL2CPP game load unity-il2cpp first.

## Evidence

Record the MelonLoader version, backend, target framework, build exit code,
deployed file hash, validation result and the Melon log tail.

## Pitfalls

- IL2CPP games need a .NET 6 target and the generated interop assemblies, while
  Mono games do not (`unity.melonloader`).
- The `MelonInfo` and `MelonGame` attributes must match the game or the mod is
  skipped silently (`unity.melonloader`).
- Do not launch the game without a `launchGame` authorization.
- Anti-cheat is risk information, not a block. Record it, tell the user, and
  continue.
