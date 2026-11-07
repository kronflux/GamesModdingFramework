---
name: gmf-safety
description: Use backups, authorizations and anti-cheat risk information correctly before writing into a game.
operations: [generic.backup, generic.restore, plan.validate, plan.apply]
---

# Safety before a game write

Use this before any operation whose effects include `gameWrite`,
`toolInstall`, `network`, `launchGame`, `antiCheat` or `execute`, and before any
destructive action.

## Steps

1. Read the operation effects from the catalog. The highest effect decides the
   gate: auto, soft or hard.
2. For a soft effect, find the authorization in the plan or in the user's
   current instruction. Quote or point to the source. Do not invent one.
3. If the target file exists, back it up first:
   `gmf run generic.backup --input gamePath="<file>" --json`.
   Keep the returned backup path and SHA-256 with the operation result.
4. Perform the write. If the write cannot be backed up, stop: a game write
   without a backup is refused.
5. If the profile has anti-cheat markers, report the `GMF-W-ANTICHEAT-001`
   warning, record the acknowledgment and continue under the normal soft gate.
   Tell the user about the online ban risk.
6. To undo a write, use `generic.restore` with the target path and verify the
   returned hash matches the original.
7. Hard effects are destructive actions, credential access and piracy.
   Credential access and piracy are always refused. A destructive action needs
   the user's explicit approval for that exact operation and target.

Engine skill next: for asset writes load unity-assets or unreal-pak-blueprint;
for Unreal helper or UE4SS installs load unreal-dumping or unreal-ue4ss-lua.

## Evidence

Record the effect, gate, authorization source, backup path and hash. An
authorization that cannot be pointed to is not an authorization.

## Pitfalls

- A plan cannot authorize a hard effect. Do not treat a plan step as user
  approval for a destructive action.
- Anti-cheat is not a hard gate. Do not refuse a mod because a marker exists,
  and do not call a bypass.
- Backups live in the workspace. A backup beside the original disappears with
  it.
- Restoring an old backup after a game update can roll back a patched file.
