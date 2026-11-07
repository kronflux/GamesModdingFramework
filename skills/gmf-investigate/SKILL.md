---
name: gmf-investigate
description: Investigate a game folder and produce an evidence-backed profile before any mod work.
operations: [game.detect, game.profile, game.inventory, knowledge.search, analyze.classes, analyze.objects, analyze.entrypoints, analyze.references]
---

# Investigate a game

Use this when a mod job starts without a current profile, after a game update,
or when a plan depends on an unverified engine, loader or runtime fact.

## Steps

1. Read the catalog so you know the available probes:
   `gmf catalog --json`.
2. Run the investigation:
   `gmf investigate --game "<game folder>" --json`.
   It detects the engine, backend, loader and markers and writes
   `gmf.profile.json` in the workspace. It never writes inside the game folder.
3. Read the profile fields in this order: `engine`, `runtime`, `loader`,
   `capabilities`, `paths`, `markers`, `unknowns`, `evidence`.
4. For each capability marked `needs-tool`, note the missing tool and the
   operation that needs it.
5. For each unknown, keep the question and the `nextProbe`. Run a probe only
   when it is read-only or the plan authorizes its effects.
6. Search the knowledge base before inventing an approach:
   `gmf run knowledge.search --input query="<subject>" --input engine=<unity|unreal>`.
7. If a target is still unidentified, use the analysis operations on the dump
   or decompiled output: `analyze.classes`, `analyze.objects`,
   `analyze.entrypoints`, `analyze.references`.

Engine skill next: for Unity targets load unity-harmony (and unity-il2cpp for
IL2CPP); for Unreal load unreal-dumping then unreal-object-model.

## Evidence

Every statement in your summary carries the profile field or the operation
result that supports it. Say "observed" when the profile read it from a shipped
file, "derived" when a deterministic step computed it, and "inferred" when it is
reasoning. List the unknowns you did not resolve.

## Pitfalls

- Detection reads the game folder. Do not create a file there, not even a log.
- An engine with unknown confidence is not selected. Ask for a manual engine
  choice instead of scaffolding a mod.
- Two engine signatures at the same confidence are a tie, not a guess.
- Anti-cheat markers are risk information. Record them and continue; do not
  refuse the job because of them.
