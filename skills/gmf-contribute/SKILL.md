---
name: gmf-contribute
description: Add an operation, knowledge note, template or test to GMF without breaking the catalog contract.
operations: [knowledge.search, plan.validate]
---

# Contribute to the framework

Use this when the job needs a capability, a knowledge note or a template that
does not exist yet.

## Steps

1. Read `AGENTS.md`, the catalog and the contract module. Find the nearest
   existing operation and copy its descriptor shape.
2. Decide where the code belongs:
   - an engine-specific capability goes in that engine module;
   - a shared capability goes in `src/operations`;
   - a knowledge note goes under `knowledge/<engine>/`;
   - a template goes under `templates/<engine>/`.
3. Write the failing test first when the behaviour is specified. Run the
   targeted test file.
4. Add the descriptor and the handler. Declare every effect, the required tools
   and a non-empty summary. A descriptor without a handler fails the catalog
   build.
5. Add the knowledge note with frontmatter: name, title, description, engine,
   tags, confidence and sources. Never promote an inference to verified.
6. Regenerate the catalog and the host files:
   `npm run build-catalog` and `npm run sync`.
7. Run the targeted tests, then `npm test`. Fix every problem; do not lower a
   check to make a run pass.

Engine skill next: to add Unity or Unreal knowledge or skills, read an existing
engine skill such as unity-harmony or unreal-ue4ss-lua and keep its format.

## Evidence

Report the files changed, the test command with its output, and the catalog and
host drift check results. A contribution without a test is unverified.

## Pitfalls

- A new engine is a module under `src/engines`; do not add engine branches to
  the core.
- Catalog generation fails when a descriptor is invalid, a handler is missing or
  a skill references a missing operation.
- Never commit game content, a decompiled file, a loader binary or an extracted
  asset. Use a synthetic fixture.
- Skills are host-neutral. Do not name a host tool or a host path.
