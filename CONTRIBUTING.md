# Contributing to gmf

gmf is a catalog of game modding operations, tools, knowledge, templates and skills that an agent or a person can run from the command line, over MCP, or as a Claude Code or Codex plugin. Contributions that keep that catalog accurate are welcome: a fixed operation, a verified knowledge note, a template that builds, a new engine module.

## Before you start

- Node.js 22 or later. The project has no runtime dependencies and uses the built-in `node:test` runner.
- Read `AGENTS.md`. It holds the project rules; the short version is below.
- Never commit game content, decompiled code, loader binaries, extracted assets or credentials. `node scripts/pre-commit.mjs --staged` checks the index for them; wire it as a pre-commit hook with `git config core.hooksPath .githooks` if you keep one, or run it by hand before you commit.

## The checks

Every change must pass the same command CI runs:

```bash
npm run check
```

It fails when the committed catalog or the generated host files are stale, then runs the full test suite. After changing an operation, a knowledge note, a skill, a template or `package.json`, regenerate them:

```bash
npm run build-catalog
npm run sync
```

Write the test before the code when the behaviour is specified. Tests use synthetic fixtures under `test/fixtures/`; none may contain real game files.

## Adding things

- **An operation.** Export a descriptor with a stable namespaced `id`, `inputs` and `outputs` JSON schemas, `effects`, `requires`, `gates`, `skill`, `docs` and a `handler`, register it from the engine or operations index, add a test, and regenerate the catalog. A soft effect (`gameWrite`, `toolInstall`, `network`, `launchGame`, `antiCheat`, `execute`) is gated by the executor; the handler never needs to ask.
- **A knowledge note.** Markdown under `knowledge/<area>/` with the frontmatter the existing notes use. Engine notes name their origin in `sources`. Label every statement `verified`, `observed` or `inferred`, and say what was checked. Per-game notes live under `knowledge/games/`; the repository ships only the synthetic example, and a game note must never carry personal data or local paths.
- **A skill.** Agent Skills under `skills/`. List the `operations` and `knowledge` ids it routes to; the catalog build fails on a missing id. Skills are host-neutral: no host-only tools, paths or slash syntax.
- **An engine.** A module under `src/engines/<id>/` exporting `detect`, `capabilities` and `operations`; see `docs/adding-an-engine.md`.
- **A tool.** An entry in `catalog/tools.json` with a pinned source, a verification method and the effects it needs. Tools are downloaded at runtime and never vendored.

## Pull requests

- One topic per pull request, with the test that proves it.
- Commit messages: `type(scope): what changed`, then a short body saying why, in the present tense.
- Say in the description what you ran and on what: the check output, and, for anything that touches a game, the engine and loader version you tested with. Say plainly what you could not verify.

## Releasing

Releases are tagged from `main`. `package.json` is marked private until the package is published to npm; installing from a clone or a packed tarball is documented in the README.
