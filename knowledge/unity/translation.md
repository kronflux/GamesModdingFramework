---
name: unity.translation
title: Unity translation workflow
description: Extract localizable strings and fonts, translate them outside the game and deploy the result as a mod rather than an asset overwrite.
engine: unity
tags: [translation, assets, fonts, text, localization]
confidence: inferred
sources: [Unity localisation package documentation, Community Unity translation workflows, earlier Unity modding framework notes]
---

# Unity translation workflow

Unity games localize text through the built-in localisation package, custom CSV
or JSON tables, or text baked into assets and prefabs.

## Steps

1. Find the text container. Search strings with `analyze.strings` and inspect
   candidate assets with `unity.inspect_asset`.
2. Extract the strings and their table keys. Keep the key order; some games look
   up rows by index.
3. Translate outside the game folder and keep the source language beside the
   translation.
4. Choose the delivery method:
   - A Harmony or BepInEx plugin that replaces a lookup result at runtime is the
     least invasive.
   - An asset replacement needs a backup and survives only until the next game
     update.
5. Check fonts. A translation with characters the shipped font lacks shows
   boxes. Ship a font asset with the needed glyphs or fall back to a supported
   script.

## Pitfalls

- Do not machine-translate names that the community already knows.
- A text asset can be shared by menus and subtitles. Replacing it changes both.
- Text length changes break layouts. Test the longest string, not the average.
- If the game reads text from a remote service, no local asset change helps.

## Translation routes

**Step 0: use what the game already has.** Search the decompiled code (`decompiled/` in the workspace) and `<Game>_Data/StreamingAssets/` for a localization layer: language tables (CSV, JSON, ScriptableObjects), I2 Localization, the Unity Localization package (`UnityEngine.Localization`) or a `GetText` or `Localize` method. If one exists, add a language through it (patch the language list and load your table) instead of intercepting every string.

**Route A: XUnity.AutoTranslator (most games).**

1. Install the build matching the installed loader (BepInEx 5, BepInEx 6 IL2CPP or MelonLoader) from its GitHub releases. Do not vendor its DLLs.
2. Launch once; it creates `AutoTranslatorConfig.ini` (BepInEx: `BepInEx/config/`) and a `Translation/<lang>/Text/` folder.
3. Set `[General] Language=<target>` and `FromLanguage=<source>`. Choose an endpoint or `Endpoint=` (none) for manual translation only.
4. Translations are `source=translation` lines in `Translation/<lang>/Text/*.txt`, UTF-8 without BOM, with `=` in source text escaped as `\=`.
5. For TextMeshPro text in scripts the game font lacks (CJK, Cyrillic), set `FallbackFontTextMeshPro` to a TMP font asset bundle covering the script.

**Route B: a Harmony postfix on the text source**, when XUnity misses text (custom renderer) or when shipping a translation as one mod:

```csharp
[HarmonyPatch(typeof(GameNamespace.LocalizedText), nameof(GameNamespace.LocalizedText.GetString))]
internal static class LocalizedText_GetString_Patch
{
    private static void Postfix(string key, ref string __result)
    {
        if (Translations.TryGet(key, __result, out var translated)) __result = translated;
        else Translations.RecordMissing(key, __result);   // append to a TSV the translator fills in
    }
}
```

Patch the lowest method every string passes through (the table lookup), not each UI component, and record untranslated strings at runtime so coverage grows from play.

**Strings inside other mods.** In BepInEx `.cfg` files translate only the `##` comment lines; never change section names or keys. Compiled mod DLLs keep literals in the `#US` heap: dump them with `ilspycmd` or a strings tool and translate through Route A or B rather than editing the DLL.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Squares or blanks | Font has no glyphs for the script | TMP fallback font (Route A step 5) or a font asset bundle |
| Mojibake (`Ã©`, `æ–‡`) | File saved in the wrong encoding | UTF-8 without BOM; LF or CRLF both work |
| Some text never changes | Text is an image, or set before the hook | Patch the source lookup; images need asset replacement (`unity.assets`) |
| Translation reverted after a game update | Source text changed | Re-record missing strings and update the table |
