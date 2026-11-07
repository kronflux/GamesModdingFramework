# Knowledge

Knowledge notes are Markdown files under `knowledge/` with flat frontmatter. `scripts/build-catalog.mjs` indexes them into `catalog/knowledge.json`; `gmf knowledge search` returns metadata and the path, not the whole document.

## Format

```markdown
---
name: unity.il2cpp.interop
title: IL2CPP interop assemblies
description: Why BepInEx 6 and MelonLoader need generated interop assemblies.
engine: unity
tags: [il2cpp, interop, bepinex6]
confidence: verified
sources: [https://example.invalid/source]
---

Body.
```

- `confidence` is `verified`, `observed` or `inferred`. A verified note was checked against a real game or tool; an observed note was read in working code or a log; an inferred note is reasoning.
- `sources` names where the claim came from. A note under `knowledge/unity` or `knowledge/unreal` must list at least one source; a note adapted from a reference project names it as `<repo>/<path>`.
- Do not put game content, decompiled code, credentials or personal data in a note.

## Search

```bash
gmf knowledge search "il2cpp interop" --engine unity --json
gmf knowledge search "anti-cheat" --tag safety
```

Search matches IDs, titles, tags and body text and returns the metadata. Open the path for the body.

## Field notes

A field note is a knowledge entry for something that cost real time: a documentation error, a crash and its real cause, or an approach that looked right and was not. Mark it `verified`, `observed` or `inferred`; never promote an inference to a fact. Put the engine in `engine` and the subject in `tags`.

## Per-game notes

A note under `knowledge/games/` records what was verified for one game. Its frontmatter carries `game`, `engine`, `store`, `appId`, `loader`, `antiCheat`, `verified` (the date and build) and `sources`; the body records the loader that worked, the targets found and the pitfalls. `knowledge/games/README.md` documents the format and `_example.md` is a synthetic example. `gmf knowledge search "<game name>"` finds a note by its game.

## Contribution

1. Add the note under `knowledge/<engine>/` or `knowledge/core/`.
2. Fill the frontmatter, including `confidence` and `sources`.
3. Run `npm run build-catalog` and `npm test`.
4. Reference the note from a skill or a workflow when it changes how a task is done.

Anti-cheat notes describe mechanisms, mod interactions, flagging and ban risk. They are risk information; they are not a gate.
