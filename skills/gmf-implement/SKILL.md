---
name: gmf-implement
description: Implement and deploy mod code for an approved plan, one step at a time.
operations: [plan.apply, unity.scaffold, unity.build, unity.deploy, unity.validate, unreal.scaffold, unreal.build, unreal.deploy, unreal.validate, generic.backup]
---

# Implement a mod

Use this when a validated plan exists and the user has supplied the
authorizations the plan needs.

## Steps

1. Re-read the plan and confirm every soft effect has a source the user
   provided.
2. Run one step at a time and read its result:
   `gmf run plan.apply --input plan=gmf.plan.json --json`.
   A step that fails stops the plan unless it is marked optional.
3. For a scaffold step, read the generated files before editing them. Keep the
   loader and backend the profile detected.
4. Write mod code under `mods/<name>/`. Do not copy game assemblies into the
   repository.
5. Before a deploy that overwrites a file, run `generic.backup` and keep the
   returned hash. The deploy operation records the backup it made.
6. After a deploy, run the matching validate operation and read every resolved
   and missing target.
7. If a step fails, stop and report the exact command, exit code and log tail.
   Move to the debug skill instead of guessing a fix.

Engine skill next: for Unity code work load unity-bepinex or unity-melonloader
plus unity-harmony (unity-il2cpp for IL2CPP games); for Unreal load
unreal-ue4ss-lua or unreal-ue4ss-cpp.

## Evidence

Each result records the operation, effects, gate, authorization source and
output. Keep the build exit code, the deployed file hash and the validation
result with the step.

## Pitfalls

- Do not invent an operation ID. If the catalog lacks it, report the gap.
- Do not skip a gate because the edit looks small. A game write is a game write.
- Do not run a plan twice without checking whether the first run already wrote
  the target. The second run backs up the modified file, not the original.
- Keep generated output under `decompiled/`, `extracted/`, `dumps/` and `mods/`
  as the workspace rules require.
