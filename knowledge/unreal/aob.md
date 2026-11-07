---
name: unreal.aob
title: Array-of-bytes signature scanning
description: Find a function or global by a byte pattern, resolve the reference and expect the signature to break on a game update.
engine: unreal
tags: [aob, signatures, pattern, scanning, updates]
confidence: observed
sources: [UE4SS documentation, Community Unreal signature scanning notes, earlier Unreal modding framework notes]
---

# Array-of-bytes signature scanning

Targets, the two Lua forms, wildcarding and the verification gate are in `unreal.aob.targets`; the fallback order is in `unreal.aob.degradation`.

A signature is a short byte pattern that identifies a function or a global in
the executable. It is a fallback when reflection does not expose what you need.

## Workflow

1. Find the code or global in a disassembler for the exact game build.
2. Choose bytes that are stable: avoid relative addresses, immediate constants
   that change per build and padding.
3. Replace changing bytes with wildcards.
4. Scan at runtime with the UE4SS scanning helpers or a mod-side scanner.
5. Resolve a RIP-relative reference from the match before using the address.
6. Record the pattern, the game build and the resolved address as evidence.

## Choosing a pattern

- A function prologue plus a unique string reference is more stable than a long
  raw byte run.
- A pattern that matches twice is not an identifier. Extend it or add a second
  check on the surrounding instructions.
- A global is often reached through a `lea` plus a fixed offset. Resolve the
  instruction, not the raw bytes.

## Pitfalls

- Every game update can move a signature. A working pattern is not permanent.
- Do not hard-code an absolute address. Address space layout and patches move it.
- A signature that matches in a different binary is a false positive. Verify the
  surrounding instructions before hooking.
- If reflection or a UFunction path resolves the target, prefer it over a
  signature.
