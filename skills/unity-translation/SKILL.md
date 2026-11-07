---
name: unity-translation
description: Use when a Unity game's text must be translated or localized by a mod, including font fallback for other scripts.
operations: [unity.scaffold, unity.decompile, analyze.strings]
knowledge: [unity.translation]
---

# Unity translation mods

This skill routes localization. Translate outside the game and deliver the
result as a mod, not as an overwritten asset.

## Steps

1. Read the approach and the font notes: `gmf knowledge show unity.translation`.
2. Check whether the game has built-in localization by decompiling:
   `gmf run unity.decompile --input gameDir=<game folder>` and searching the
   output for localization managers.
3. Collect candidate text: `gmf run analyze.strings --input query=<pattern>`.
   Record where each string is read (the text source method).
4. Choose the delivery: an existing translator plugin, or a Harmony postfix on
   the text source. For the second, load unity-harmony.
5. Scaffold the mod: `gmf run unity.scaffold --input name=<mod> --input loader=<bepinex5|bepinex6|melonloader>`.
6. Add a font fallback for CJK or other scripts as the note describes.
7. Build and deploy with unity-bepinex or unity-melonloader.

## Evidence

Record the string source (type and method), the count of strings found, the
language pair, the font used and which strings stayed untranslated.

## Pitfalls

- Translating at the asset level breaks on every game update
  (`unity.translation`).
- A missing glyph shows as a box; the fallback font must cover the script
  (`unity.translation`).
- Strings built by concatenation need the whole template translated, not the
  pieces.
- Never commit game text dumps. Anti-cheat is risk information, not a block;
  record it and continue. Do not launch the game without `launchGame`
  authorization.
