---
name: unreal.gamedocs
title: The gamedocs folder of an Unreal game
description: What unreal.build_docs writes into gamedocs/, which page answers which modding question, and how to read the pages without loading the whole folder.
engine: unreal
tags: [gamedocs, docs, dumps, classes, bytecode, levels, datatables, settings, localization]
confidence: verified
sources: [gmf src/engines/unreal/docs, GmfDumper run on a UE 5.6 IoStore title 2026-11-12 (8095 pages)]
---

# The gamedocs folder

`unreal.build_docs` turns one collected GmfDumper run, plus the text files read
from the containers, into Markdown under `<workspace>/gamedocs/`. It is game
content: it stays in the workspace and is never committed.

## Start here

1. `gamedocs/overview.md`: the game, its engine version, the game mode, player
   classes and the largest systems, each with a link.
2. `gamedocs/README.md`: the sections that exist, and the sections that are
   missing with the reason (for example the native part did not load).
3. `gamedocs/index.jsonl`: one line per page with its kind, name, path and
   file. Search it instead of listing folders.

Every page starts with front matter (`kind`, `name`, `path`, `source`). A page
larger than 100 KB is split into parts that link to each other; its `_index.md`
lists the parts.

## Which page answers which question

| Question | Page |
|---|---|
| What properties and functions does a class have, and who uses it? | `classes/<Name>.md` ("Used by" lists references) |
| What does a Blueprint function do? | `classes/<Name>.script.md` (decoded bytecode) |
| What are the default values of a class and its components? | `classes/<Name>.md`, section "Defaults" (shown as a diff against the parent class) |
| What is in a struct or an enum? | `structs/`, `enums/` |
| What rows does a data table hold? | `data_tables/` |
| What values does a data asset or a curve hold? | `data_assets/`, `curves/` |
| What values do other assets hold (sound classes, input actions, ...)? | `asset_values/<Class>.md` |
| Which actors are placed in a level, with which values? | `levels/<Map>/` (values shown as a diff against the class) |
| What is running right now (game mode, controller, pawn, HUD)? | `world/` |
| How are the UI widgets built? | `ui/` |
| Which config classes read which ini values? | `config/` |
| What do the game's ini files set? | `settings/<file>.md` |
| Which console variables exist, and which do the ini files set? | `console/overview.md`, `console/<prefix>.md` |
| What text does the game show, per language? | `localization/<culture>/<namespace>.md` |
| Which plugins does the game ship? | `plugins.md` |
| Which assets exist, by folder and class? | `assets/` |
| Which gameplay tags and names exist? | `names/` |

## Limits

- A page describes the build that was dumped. Dump again after a game update.
- Values come from memory at dump time. Level pages come from maps loaded as
  data, so no game code ran for them.
- Bytecode pages show structure (if, loops, sequences) where it could be
  recovered and a flat listing otherwise. Statement order is never changed.
- Console variable names are read from the game executable, because a
  shipping build has no command that lists them (`DumpConsoleCommands` and
  `help` are compiled out). The list has no help text and no live values, and
  it holds some names that are not console variables, such as stat names. A
  name with a value from an ini file is a real console variable.
