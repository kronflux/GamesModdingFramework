# Adding an engine

An engine is a module under `src/engines/<id>/`. The core loads every module directory and calls its `detect`. A module must not import another engine module.

## Module shape

```js
export default {
  id: "godot",
  name: "Godot",
  version: "0.1.0",
  async detect(gameDir, options) {
    return {
      engine: { id: "godot", version: "4.x", confidence: "observed", evidence: [] },
      markers: { antiCheat: [], online: false, launcher: null },
      paths: {},
      notes: [],
      unknowns: []
    };
  },
  capabilities(profile) {
    return [{ id: "assets", support: "partial", requires: [], reason: "PCK extraction" }];
  },
  operations: [],
  templatesDir: "templates/",
  knowledgeDir: "knowledge/",
  tools: []
};
```

## Detection rules

- Read only the game root, its metadata and a few header files. Do not scan archives or every asset.
- Return `confidence: "observed"` only when a shipped marker was read. Use `derived` or `inferred` for weaker evidence.
- When two engines match at `observed`, the selector returns no selected engine and keeps the alternatives.
- Record unknowns with a next probe rather than guessing.

## Operations

Each operation has a descriptor and a handler. Use `registerOperation` or export the descriptors in the module's `operations` array; the catalog builder reads them and fails when a handler is missing. Give each operation the descriptor fields listed in `docs/catalog.md`.

## Templates and knowledge

- `templates/<type>/template.json` describes a template; the files beside it are rendered with `{{variable}}` placeholders.
- `knowledge/**/*.md` frontmatter supplies the knowledge ID, title, engine, tags, summary, confidence and sources.

## Tests

Add synthetic fixtures under `test/fixtures/<engine>-*`. Do not include game content. Test detection, the operation registry, one end-to-end operation and the no-match case. Run `node --test` on your files, then `npm run build-catalog` and the full suite.
