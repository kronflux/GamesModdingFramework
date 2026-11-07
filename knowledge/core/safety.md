---
name: core.safety
title: Backups and hard gates before game writes
description: Copy an existing game file into the workspace before overwriting it and refuse writes that cannot be backed up.
engine: core
tags: [safety, backups, destructive, gameWrite, restore]
confidence: verified
sources: [GMF design documentation (docs/architecture.md, docs/catalog.md, docs/authorization.md), GMF authorization documentation]
---

# Backups and hard gates before game writes

A write into the game folder is reversible only when the previous file exists
somewhere else.

## Before a game write

1. Resolve the target path and check whether it exists.
2. If it exists, run `generic.backup` with `gamePath`. It copies the file under
   `backups/` and records the SHA-256 and the source path in the manifest.
3. Perform the write.
4. Record the backup path and hash in the operation result.

If a file cannot be read or copied, the write is hard gated: stop and report it.
A game write without a backup is not authorized by a plan authorization alone.

## Restoring

`generic.restore` looks up the latest recorded backup for the target, verifies
its hash and copies it back. It returns the original hash so a caller can
compare it with the pre-write hash. Restore is a `gameWrite` and needs the normal
soft authorization.

## Destructive effects

Deleting a file, deleting a folder tree, clearing a cache the game owns and
overwriting without a backup are `destructive`. They require explicit user
approval for the exact operation and target. A plan cannot grant that approval.

## Pitfalls

- A backup in the same folder as the original disappears with it. Keep backups
  in the workspace.
- Hashing after the write proves nothing about the original. Hash the copy.
- Restoring an older backup after a game update can roll back a patched file.
  Check the game version before restoring.
