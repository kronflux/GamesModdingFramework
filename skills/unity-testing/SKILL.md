---
name: unity-testing
description: Use when a Unity mod needs unit tests, a CI build without game assemblies, or a failure must be debugged from logs and profiling.
operations: [unity.build, unity.validate, generic.run_tool]
knowledge: [unity.testing, unity.testing.ci, unity.debugging, unity.debugging.logs, unity.debugging.performance]
---

# Unity testing and debugging

This skill routes verification and diagnosis for Unity mods: what can be tested
outside the game, how CI builds, and how to read a failure.

## Steps

1. Extract patch logic into pure methods and test those only:
   `gmf knowledge show unity.testing`.
2. For a CI runner with no game files read the three workable options:
   `gmf knowledge show unity.testing.ci`.
3. Build and check: `gmf run unity.build --input modDir=<mod folder>`, then
   `gmf run unity.validate --input modDir=<mod folder>`.
4. Run a test tool through the catalog, not an ad hoc command:
   `gmf run generic.run_tool --input tool=dotnet --input args="test"`.
5. On a failure read the first error, not the last:
   `gmf knowledge show unity.debugging`, then log locations and exception
   signatures in `gmf knowledge show unity.debugging.logs`.
6. For slowness read what a mod can measure:
   `gmf knowledge show unity.debugging.performance`.
7. Change one thing, rerun the same command, and compare.

## Evidence

Record the exact command, exit code, first error line, log path and the single
cause you tested. Say which part the tests did not cover.

## Pitfalls

- Unity and loader types cannot be unit-tested or mocked well
  (`unity.testing`).
- Game DLLs must never be committed to make CI build
  (`unity.testing.ci`).
- A patch that does not apply fails quietly; check target resolution
  (`unity.debugging`).
- Do not launch the game without a `launchGame` authorization; ask the user for
  the log of their run. Anti-cheat is risk information, not a block.
