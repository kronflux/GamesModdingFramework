---
name: unreal-aob
description: Use when a UE4SS or PatternSleuth scan fails and a byte-pattern signature must be analyzed, emitted and verified by hand.
operations: [unreal.pe_analyze, unreal.aob_emit, unreal.aob_verify]
knowledge: [unreal.aob, unreal.aob.targets, unreal.aob.degradation]
---

# Unreal AOB signatures

This skill routes hand-authored signatures. A signature breaks on a game update,
so treat every one as evidence tied to one executable.

## Steps

1. Identify the missing target and read what each needs:
   `gmf knowledge show unreal.aob.targets`.
2. Read the method: `gmf knowledge show unreal.aob`.
3. Inspect the executable: `gmf run unreal.pe_analyze --input exe=<shipping exe>`
   for sections, imports, exports and the text range. Hash it with
   `gmf run generic.hash --input file=<shipping exe>`.
4. If the target cannot anchor cleanly follow the ordered fallback in
   `gmf knowledge show unreal.aob.degradation`.
5. Emit a pattern at the chosen offset:
   `gmf run unreal.aob_emit --input exe=<shipping exe> --input offset=<hex>`.
6. Verify uniqueness: `gmf run unreal.aob_verify --input exe=<shipping exe> --input pattern="<pattern>"`.
   Accept only a pattern with exactly one match.
7. Paste a verified pattern into the UE4SS signatures file in the workspace mod
   folder, not into the game folder, until a deploy is authorized.

## Evidence

Record the executable hash and build, the target name, the offset, the pattern
and mask, the match count and the fallback step used.

## Pitfalls

- A pattern that matches more than once is not a signature (`unreal.aob`).
- RIP-relative displacements change between builds; wildcard them
  (`unreal.aob`).
- The scan failing is not always a pattern problem; read the scan log first
  (`unreal.debugging`).
- `unreal.field-notes` and `unreal.mined-gotchas` hold no signature data; do not
  invent one.
- Never commit the executable. Anti-cheat is risk information, not a block.
  Do not launch the game without a `launchGame` authorization.
