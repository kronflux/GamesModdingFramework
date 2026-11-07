---
name: core.games
title: Per-game notes
description: Format for a per-game knowledge note under knowledge/games, with the game, engine, store, appId, loader, antiCheat, verified and sources frontmatter fields.
engine: core
tags: [games, format, profile, knowledge]
confidence: observed
sources: [docs/knowledge.md]
---

# Per-game notes

One Markdown file per game, `knowledge/games/<slug>.md`. The folder holds only `_example.md` until notes are added; users and contributors add notes as they learn a game. A game note records facts about one game that engine notes cannot: which loader works, the anti-cheat in use, build quirks, known object and class names the user has verified. It never contains game content, decompiled code, extracted assets, credentials or personal data (`core.safety`).

## Frontmatter

The catalog fields from `docs/knowledge.md` apply (`name`, `title`, `description`, `tags`, `confidence`, `sources`), plus these fields:

```markdown
---
name: games.<slug>
title: <Game title>
description: One line on what this note records.
engine: unity
tags: [game, <loader>, <anti-cheat>]
confidence: observed
game: <Game title>
store: steam
appId: 123456
loader: bepinex5
antiCheat: none
verified: 2026-01-31
sources: [workspace profile gmf.profile.json, loader log]
---
```

| Field | Meaning |
|---|---|
| `game` | The game's display name. |
| `engine` | `unity`, `unreal` or another engine family the profile detected. Use `core` only for notes that are not tied to an engine, such as `_example.md`. |
| `store` | `steam`, `epic`, `gog`, `xbox`, `other` or `unknown`. |
| `appId` | The store's numeric or string identifier, or `unknown`. |
| `loader` | The mod loader that works for this game: `bepinex5`, `bepinex6`, `melonloader`, `ue4ss`, `none` or `unknown`. |
| `antiCheat` | The anti-cheat system found (`eac`, `battleye`, `vanguard`, `custom`, `none`) or `unknown`. Risk information only (`core.anti-cheat`). |
| `verified` | ISO date of the last check against a real install, or `never`. |
| `sources` | Where each claim came from: the workspace profile, a loader log, a tool run, a linked page. A game note must name at least one source. |

`confidence` follows the usual rule: `verified` means checked against a real game or tool, `observed` means read in working code or a log, `inferred` is reasoning.

## Body

Short sections with one claim per bullet and its evidence: **Detection** (what identified the engine and loader), **Loader** (what works and what failed), **Anti-cheat**, **Known targets** (class, method or object names, as names only), **Pitfalls**. Link engine notes by id (`unity.bepinex`, `unreal.ue4ss.install`) instead of repeating them.

## Search

```bash
gmf knowledge search "steam" --tag game
gmf knowledge search "bepinex5" --engine unity
```
