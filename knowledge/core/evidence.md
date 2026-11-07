---
name: core.evidence
title: Evidence and confidence labels
description: Record every finding with a claim, a confidence label, an authority and a source so a later agent can recheck it.
engine: core
tags: [evidence, confidence, unknowns, provenance]
confidence: verified
sources: [GMF design documentation (docs/architecture.md, docs/catalog.md, docs/authorization.md)]
---

# Evidence and confidence labels

A finding without evidence is a guess. Every detection and every operation
result that matters carries evidence records.

## Record shape

```json
{
  "id": "ev_...",
  "claim": "Unity 2021.3.45f1 is the engine version",
  "confidence": "observed",
  "authority": "shipped-artifact",
  "source": "Game_Data/globalgamemanagers",
  "detail": {}
}
```

- `observed`: read directly from a shipped file, a log or an operation output.
- `derived`: computed from observed facts by a deterministic step.
- `inferred`: reasoning that a later probe could confirm or refute.

Authority is one of `shipped-artifact`, `controlled-replay`, `user-stated`,
`external` or `analyst-inference`. Confidence and authority answer different
questions: how sure, and why.

## Unknowns

An unknown has a question, a severity and a `nextProbe`. Keep unknowns in the
profile instead of silently guessing. A high or critical unknown belongs in the
plan notes so the user sees it before a game write.

## Pitfalls

- Do not promote an inference to observed because it matched your expectation.
- Do not record a claim whose source is only the model's memory.
- Do not drop a contradicted evidence record. Keep it and add the new record so
  the disagreement is visible.
