---
name: unreal.aob.degradation
title: AOB degradation chain
description: The ordered fallback for a UE4SS signature target that will not anchor cleanly, from exports-first through anchored disassembly, Ghidra, pasted debugger output and fully manual work, with the trigger for each escalation.
engine: unreal
tags: [aob, signatures, ue4ss, reverse-engineering, ghidra, x64dbg]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Degradation chain

The default path for hand-authoring a signature (`unreal.aob.targets`). Each step fires only when the previous step's gate fails; never skip ahead and never retreat to a cruder step because it feels faster. Automation gives way to human and tool assistance as the target gets harder, but the end contract, the three-part verification gate in `unreal.aob.targets`, is the same whichever step produced the candidate.

## 1. Exports-first

**Trigger:** always, for every target, before any scanning. Check the PE export table for the target's mangled symbol. If present, emit the export form and go to the gate (section membership and runtime confirmation still apply; there is no uniqueness question).

**Escalates when** the symbol is not exported, the common case for statically-linked, non-modular Shipping builds.

## 2. Anchored disassembly

**Trigger:** exports-first found nothing. Narrow the search before reading disassembly blind:

- **PatternSleuth log found addresses.** A failed target is often close to, or reachable by call or xref from, a resolved symbol in the same translation unit or subsystem (`GNatives` near Blueprint-execution functions; `GMalloc` reachable from `FMemory::Free`).
- **String cross-references.** If the target touches a literal (assert message, log format, class name), find it in `.rdata`, find code referencing it, walk from there.
- **The RE-UE4SS guide's anchoring patterns**: `StaticConstructObject` through a `CALL` inside `UUserWidget::InitializeInputComponent`; `GMalloc` through the `MOV` nearest the first `CALL` in `FMemory::Free`. Reuse directly where they apply; as a template (find a nearby easier caller or accessor, resolve from there) where they do not.

Once a range is localized, disassemble it and choose and wildcard a byte run per the rules in `unreal.aob.targets`.

**Escalates when** no neighbour, string xref or known pattern narrows the range enough to give a plausible byte run: anchoring failure is the explicit trigger. This differs from a scan returning zero or several matches, which is a verification-gate failure handled by iterating byte selection here; escalation means there was no reasonable starting point.

## 3. Ghidra-assisted cross-references (optional accelerator)

**Trigger:** anchoring failure in step 2. Load the binary in Ghidra (or pyghidra) for function boundaries, an approximate call graph and xref listings far costlier to rebuild by hand. Walk from a hard anchor (a vtable, an RTTI type name, a string with no direct xref in the window already examined) to the target. Optional: it needs the tool installed and is slower per iteration than byte scanning.

**Escalates when** analysis still gives no confident unique candidate (misidentified function boundaries, packed or obfuscated binary, a dead-ended xref chain).

## 4. Pasted debugger output (x64dbg-assisted)

**Trigger:** Ghidra (or, if skipped, anchored disassembly) has not produced a confident candidate and a human has Windows-side tooling and the game running live. This is the RE-UE4SS guide's primary workflow: the human runs the game under **x64dbg**, uses the **Symbols** tab to find a named function (when PDBs exist for a same-version blank project) or navigates memory, and copies raw bytes (optionally via **Baymax Tools** or **Swiss Army Knife** for ready wildcarded patterns). They paste the bytes back; the pattern is scanned against the binary, checked for uniqueness and section membership, and turned into a `.lua`. The workflow cannot originate this data, only validate what is pasted.

**Escalates when** even with live memory and a debugger no reliable unique signature emerges (heavy obfuscation, no comparable blank-project binary, or the human cannot find a working byte sequence).

## 5. Guided-manual

**Trigger:** every automated and semi-automated step failed the verification gate. Stop trying to originate candidates and walk the human through the full manual RE-UE4SS process (`fixing-compatibility-problems-advanced.md`): build a same-UE-version blank Shipping project with debug symbols, compare it with the target in x64dbg, and hand-derive both the `Register()` AOB and the `OnMatchFound` calculation. The slowest step, but with no automation ceiling: a human doing full manual RE can solve cases no heuristic or auto-analysis can.

## The `CustomGameConfigs` corpus is a seed, not a lookup

At every step, RE-UE4SS's `CustomGameConfigs/<Game>/UE4SS_Signatures/*.lua` (external, not bundled; https://github.com/UE4SS-RE/RE-UE4SS) is a **per-engine-version pattern seed**. If the target and a corpus game share the engine version (ideally also build config: modular versus monolithic, MSVC versus Clang), a similar byte structure or anchoring approach is a reasonable hypothesis to test. It is never keyed by name: the same target in two games on one version can need different bytes (compiler, padding, alignment, inlining). Every candidate from the corpus must still clear the full gate against the actual binary.
