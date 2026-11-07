---
name: unreal.aob.targets
title: AOB signature targets and authoring workflow
description: The eleven UE4SS_Signatures targets (GUObjectArray, FName_ToString, FName_Constructor, StaticConstructObject, GMalloc, GNatives and more), the OnMatchFound contract for each, the two Lua signature forms, wildcarding rules and the three-part verification gate.
engine: unreal
tags: [aob, signatures, ue4ss, patternsleuth, reverse-engineering, guobjectarray, fname]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# AOB signature targets and authoring workflow

Authoring `UE4SS_Signatures/*.lua` when PatternSleuth's built-in scan cannot find a symbol. Every emitted signature is a claim about one game binary; the only truth is that binary plus the runtime UE4SS log, never a name match against another game's config. Fallback order when a target will not anchor: `unreal.aob.degradation`. Overview: `unreal.aob`. Further reading: RE-UE4SS guides `fixing-compatibility-problems.md` and `fixing-compatibility-problems-advanced.md`, https://github.com/UE4SS-RE/RE-UE4SS/tree/main/docs/guides.

Tooling: `gmf run unreal.pe_analyze`, `unreal.aob_emit` and `unreal.aob_verify` cover PE section and export listing, signature emission and verification where the installed gmf provides them; otherwise do the same steps with a disassembler.

## The eleven targets

Filenames are case-sensitive stems. `OnMatchFound` (or the file-scope return) must resolve to:

| Target | Required | Must return |
|---|---|---|
| `GUObjectArray` | Required | Exact address of the global variable `GUObjectArray` (data, not a function). |
| `FName_ToString` | Required | Start of `FName::ToString`: `public: void cdecl FName::ToString(class FString & ptr64)const __ptr64`. |
| `FName_Constructor` | Required | Start of `FName::FName`: `public: cdecl FName::FName(wchar_t const * ptr64,enum EFindName) __ptr64`. UE4SS verifies the match internally, so an AOB that also matches the `char*` overload is fine if the `wchar_t const*` one is found too. |
| `StaticConstructObject` | Required | Start of `StaticConstructObject_Internal`: `class UObject * __ptr64 __cdecl StaticConstructObject_Internal(struct FStaticConstructObjectParameters const & __ptr64)`. |
| `GMalloc` | Required | Exact address of the global `GMalloc`. |
| `GNatives` | Optional | Exact address of the global `GNatives`. |
| `GUObjectHashTables` | Optional (incomplete upstream) | "The address of the hash tables structure"; no documented recipe, treat any candidate as unverified until runtime-confirmed. |
| `ConsoleManager` | Optional (incomplete upstream) | "The address of the console manager"; same caveat. |
| `ProcessLocalScriptFunction`, `ProcessInternal`, `CallFunctionByNameWithArguments` | Not required 99% of the time | Exact address of that function. Pursue only if the log reports it failed and something you need depends on it. |

## Per-target recognition hints

Hints are heuristics that narrow the search; they do not replace the verification gate.

- **GUObjectArray.** Rarely exported in shipping builds; expect an AOB. Anchor on code that touches it early, such as `UObjectBase::AddObject`: a RIP-relative `LEA`/`MOV` of the array base followed by chunked-array bookkeeping (bounds checks, index arithmetic). Known working signatures are direct-return AOBs chosen to land on the address computation, with no `DerefToInt32`.
- **FName_ToString.** Sometimes exported (look for `?ToString@FName@@...`; exports first). When scanning, the prologue branches on the FName's number or index fields before the string-table lookup, unlike the constructor (writes fields) or `GetPlainNameString` (a simpler accessor).
- **FName_Constructor.** Frequently exported in modular builds: `??0FName@@QEAA@PEB_WW4EFindName@@@Z`, a pure `return LoadExport("...")` (a canonical Form 1 file). Not exported: called extremely often, so call sites are easy but the target's own prologue must be matched, with the wide-string hashing loop and a comparison of the `EFindName` argument.
- **StaticConstructObject.** UE4SS's built-in scan anchors on a caller: it finds a `CALL` in the middle of `UUserWidget::InitializeInputComponent` and resolves the target. Reuse that: locate the function (by string or vtable xrefs to `UUserWidget`), find the call to `StaticConstructObject_Internal`, resolve the relative displacement (the indirect form with `DerefToInt32`). Commonly needed target.
- **GMalloc.** UE4SS's built-in scan finds `FMemory::Free` and resolves the `MOV` closest to the first `CALL` in it. `FMemory::Free` loads `GMalloc` and calls through the allocator vtable with a pointer argument; short, thunk-like, easy to confirm. The load's RIP-relative operand is `GMalloc`.
- **GNatives.** A large dense array of code pointers (one per Blueprint VM opcode, `EExprToken`), all into `.text`, near Blueprint execution code (`UFunction::Invoke`, `ProcessInternal`, `ProcessLocalScriptFunction`).
- **GUObjectHashTables.** Known working examples are direct-return AOBs landing on the data reference. They show the shape of a working signature, not the resolution strategy for a new game.
- **ConsoleManager.** No worked example is known; the least-anchored of the eleven. Expect to escalate down the degradation chain sooner.
- **ProcessLocalScriptFunction, ProcessInternal, CallFunctionByNameWithArguments.** `ProcessLocalScriptFunction` is part of the Blueprint VM's dispatch for locally-resolved script functions; `ProcessInternal` is the core native or script invocation path; `CallFunctionByNameWithArguments` looks up and calls a UFunction by name with string-parsed arguments (console and debug tooling).

Worked examples live in RE-UE4SS's `CustomGameConfigs/<Game>/UE4SS_Signatures/*.lua` corpus (external, not bundled; https://github.com/UE4SS-RE/RE-UE4SS). It is a per-engine-version pattern seed, never a lookup key.

## The two `.lua` forms

**Form 1: file-scope export return.** Only when the symbol is actually exported (check the PE exports first).

```lua
-- <Game>, UE <version>
-- <human-readable C++ signature comment>
return LoadExport("<mangled-name>")
```

**Form 2: `Register()` plus `OnMatchFound(MatchAddress)`.** The general case. Direct, when the AOB already leads to the target:

```lua
function Register()
    return "48 8B C4 57 48 83 EC 70 80 3D ?? ?? ?? ?? ?? 48 89"
end

function OnMatchFound(MatchAddress)
    return MatchAddress
end
```

Indirect, using UE4SS's global `DerefToInt32(address) -> int32|nil` (and `print` for debugging) when the match is a few instructions from a RIP-relative operand:

```lua
function Register()
    return "41 B8 01 00 00 00 48 8D 15 ?? ?? ?? ?? 48 8D 0D ?? ?? ?? ?? E9"
end

function OnMatchFound(MatchAddress)
    local InstrSize = 0x05
    local JmpInstr = MatchAddress + 0x14
    local Offset = DerefToInt32(JmpInstr + 0x1)
    return JmpInstr + Offset + InstrSize
end
```

Render the final file with the emitter (export, direct and indirect shapes) rather than formatting Lua by hand.

## Wildcarding rules

An AOB is hex nibbles, two per byte, spaces optional (`8B 51 04 85` equals `8B510485`). `??` wildcards a full byte; `?` a single nibble (`4?` matches `40` to `4F`). Wildcard what varies between builds; keep what encodes structure.

- Wildcard: RIP-relative displacements (the 4 bytes after a `48 8D 05` or `48 8B 05` style opcode and ModRM), absolute 32 or 64-bit addresses, and immediates that are data (offsets, compile-tied magic constants).
- Keep fixed: opcodes, ModRM and SIB bytes, REX prefixes, and immediates structural to the instruction (a small stack-alloc size reflecting the same locals).
- When unsure, disassemble the range and wildcard operand bytes, not opcode bytes; operand ranges follow from instruction size minus opcode prefix length.

## Exports first

Before scanning, check the PE export table for the target's mangled name. If present, emit Form 1 and skip scanning: more reliable and cheaper. Scan (Form 2) only when it is not exported, the common case for statically-linked, non-modular builds.

## The three-part verification gate

**Uniqueness alone never authorizes an emit.** A signature must clear all three before it is written to `UE4SS_Signatures/`, and is not confirmed until a human relaunches the game; this workflow cannot launch the game.

1. **Unique match.** Scan the entire binary; exactly one RVA. Zero means wrong or over-constrained (a byte that does vary). More than one means widen the run or add context; do not pick the "obviously right" one.
2. **Semantic sanity.** The resolved address must be inside an executable section; check every executable section, there can be more than one. Compare with the PatternSleuth log's found addresses for neighbouring symbols; wildly out of range suggests a coincidental unique hit on the wrong function.
3. **Runtime-log confirmation (human in the loop).** Deploy the `.lua`, have the human relaunch, and confirm the UE4SS startup log now resolves the symbol. A unique, in-section match can still be a thunk, a differently specialized template or an unrelated function sharing a byte run; only runtime confirmation closes that.

## End-to-end workflow

1. **Anchor.** Parse the PatternSleuth log for the engine version, the found map (resolved symbols as anchors) and the failed list (which `.lua` files are needed). Work only targets that failed.
2. **Load the PE once** and reuse sections, exports and bytes.
3. **Exports first.** If present, emit Form 1 and go to gate 1 (section membership and runtime still apply).
4. **Localize a candidate range** from found addresses and string cross-references rather than disassembling blind.
5. **Disassemble the range**; pick a unique-looking run and apply the wildcarding rules.
6. **Emit** the direct or indirect form.
7. **Verify** with the three gates in order; on failure iterate step 5 or escalate per `unreal.aob.degradation`.
