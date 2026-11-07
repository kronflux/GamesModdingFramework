# Catalog

`gmf catalog --json` returns the framework's public surface:

- `operations`: what the framework can do.
- `tools`: external tools it can install and invoke.
- `knowledge`: engine and core notes with confidence labels.
- `templates`: mod project templates.
- `skills`: the Agent Skills that explain workflows, each with the `operations` and `knowledge` ids it routes to.
- Templates carry a `kind`: `scaffold` (a whole mod), `feature` or `helper` (files copied into a scaffold) or `payload` (deployed beside a loader, such as the dump helper).

## Operation descriptor

```json
{
  "id": "unity.decompile",
  "title": "Decompile Unity assemblies",
  "summary": "Dump Mono assemblies with ilspycmd or IL2CPP assemblies with Cpp2IL or Il2CppDumper.",
  "engine": "unity",
  "inputs": { "type": "object", "properties": {}, "required": [] },
  "outputs": { "type": "object", "properties": {} },
  "effects": ["read", "workspaceWrite"],
  "requires": ["ilspycmd"],
  "gates": ["auto"],
  "skill": "unity-il2cpp",
  "docs": ["knowledge/unity/il2cpp-interop.md"]
}
```

Rules:

- The ID is namespaced and stable: `game.*`, `tool.*`, `plan.*`, `verify.*`, `analyze.*`, `generic.*`, `knowledge.*`, `skill.*`, `workspace.*`, `unity.*`, `unreal.*`.
- `effects` is non-empty and uses the effect names in `docs/authorization.md`.
- `gates` must include the gate computed from the effects.
- `requires` names tool IDs from `catalog/tools.json`.
- A descriptor without a handler fails catalog generation.
- A skill that names an operation or knowledge id that does not exist fails catalog generation.
- A knowledge note under `knowledge/unity` or `knowledge/unreal` with an empty `sources` list fails catalog generation.

## Generated catalog

`scripts/build-catalog.mjs` loads every engine module, collects its operation descriptors, scans `knowledge/**/*.md`, `templates/**/template.json` and `skills/*/SKILL.md`, and writes the five catalog files. `npm run build-catalog -- --check` fails when the source and the generated files disagree. Commit the generated files with the source change.

## Adding an operation

1. Add the handler and descriptor to the owning engine module or `src/operations`.
2. Give it an ID, input and output schema, effects, required tools and gate.
3. Add a test that calls `executeOperation` with valid and invalid inputs.
4. Run `node --test <test>` and `npm run build-catalog`.
5. Reference the operation from a skill if it belongs to a workflow.

## Reading the catalog as an agent

Read `gmf catalog --json` before inventing a command. Use `gmf run <operation-id> --input key=value --json` for any operation. Use `gmf catalog --engine unity` or `--kind knowledge` to narrow the list. `gmf skill list` and `gmf knowledge show <id>` print a skill or a note; `gmf tool list` shows which registered tools resolve on this machine.
