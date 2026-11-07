// Signature toolkit tests: PE analysis, instruction length decoding, Lua signature
// emitters and PatternSleuth log parsing, one Node test per case.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parsePe, execSection, execSections, scan, rvaInSection, rvaToFileOffset } from "../src/engines/unreal/sig/pe.mjs";
import { decodeLength, decodeAtRva } from "../src/engines/unreal/sig/disasm.mjs";
import { emitExport, emitAob, emitIndirect, emitSignature, findPattern } from "../src/engines/unreal/sig/emit.mjs";
import { parsePatternSleuthLog } from "../src/engines/unreal/sig/pslog.mjs";
import { executeOperation } from "../src/core/operations.mjs";
import "../src/engines/unreal/operations/sig.mjs";
import {
  buildPe32Plus,
  buildCodePe,
  buildPeTwoExec,
  buildTruncatedAfterPeSig,
  writeTemp,
  IMAGE_BASE,
  MACHINE_AMD64,
  MAGIC_PE32,
  MEM_EXECUTE,
  MEM_READ,
  SEC_TABLE_OFF,
  VADDR,
  RAW_OFF,
  OPT_OFF,
  E_LFANEW,
  TIMESTAMP,
} from "./fixtures/sig/build-pe.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";

const { image, meta } = buildPe32Plus();

async function withTemp(data, fn) {
  const tmp = writeTemp(data);
  try {
    return await fn(tmp.path);
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
}

// ---- PE analysis ----

test("pe_analyze: load pe headers", () => {
  const pe = parsePe(image);
  assert.equal(pe.isPe32Plus, true);
  assert.equal(pe.imageBase, IMAGE_BASE);
  assert.equal(pe.machine, MACHINE_AMD64);
  assert.equal(pe.sections.length, 1);
});

test("pe_analyze: text section", () => {
  const text = parsePe(image).sections[0];
  assert.equal(text.name, ".text");
  assert.equal(text.virtualAddress, VADDR);
  assert.equal(text.rawOffset, RAW_OFF);
  assert.equal(text.rawSize, meta.rawSize);
  assert.ok(text.flags & MEM_EXECUTE);
});

test("pe_analyze: exec section", () => {
  assert.equal(execSection(parsePe(image)).name, ".text");
});

test("pe_analyze: exec sections multiple", () => {
  const pe = parsePe(buildPeTwoExec());
  assert.deepEqual(execSections(pe).map((s) => s.name), [".text", ".text1"]);
  assert.equal(execSection(pe).name, ".text");
});

test("pe_analyze: scan exact match", () => {
  const pe = parsePe(image);
  const hits = scan(pe, "48 89 5C 24 08", image);
  assert.deepEqual(hits, [meta.codeRva]);
  assert.ok(rvaInSection(pe, hits[0], pe.sections[0]));
});

test("pe_analyze: scan byte wildcard", () => {
  assert.deepEqual(scan(parsePe(image), "48 89 ?? 24 08", image), [meta.codeRva]);
});

test("pe_analyze: scan nibble wildcard", () => {
  assert.deepEqual(scan(parsePe(image), "4? 89 5C 24 08", image), [meta.codeRva]);
});

test("pe_analyze: scan no spaces", () => {
  assert.deepEqual(scan(parsePe(image), "48895C2408", image), [meta.codeRva]);
});

test("pe_analyze: scan absent pattern", () => {
  assert.deepEqual(scan(parsePe(image), "DE AD BE EF CA FE", image), []);
});

test("pe_analyze: scan section scoped", () => {
  const pe = parsePe(image);
  assert.deepEqual(scan(pe, "48 89 5C 24 08", image, execSection(pe)), [meta.codeRva]);
});

test("pe_analyze: exports", () => {
  const pe = parsePe(image);
  assert.ok(pe.exports.includes(meta.exportName));
  assert.equal(pe.exportRvas[meta.exportName], meta.exportRva);
});

test("pe_analyze: reject pe32", () => {
  const img = Buffer.from(image);
  img.writeUInt16LE(MAGIC_PE32, OPT_OFF);
  assert.throws(() => parsePe(img), /PE32/);
});

test("pe_analyze: reject non pe", () => {
  assert.throws(() => parsePe(Buffer.from("this is not a PE file at all".repeat(8))), /MZ/);
});

test("pe_analyze: reject truncated after pe sig", () => {
  // Must be an Error from the parser, not a raw RangeError from Buffer reads.
  assert.throws(
    () => parsePe(buildTruncatedAfterPeSig()),
    (error) => error instanceof Error && !(error instanceof RangeError) && /truncated|past end/.test(error.message),
  );
});

test("pe_analyze: reject missing pe sig", () => {
  const img = Buffer.from(image);
  img.writeUInt32LE(0xdeadbeef, E_LFANEW);
  assert.throws(() => parsePe(img), /PE\\0\\0/);
});

test("parsePe reports imports, timestamp and the text range", () => {
  const pe = parsePe(image);
  assert.deepEqual(pe.imports, [{ dll: meta.importDll, names: [meta.importName] }]);
  assert.equal(pe.timestamp, TIMESTAMP);
  assert.deepEqual(pe.textRange, { start: RAW_OFF, end: RAW_OFF + meta.rawSize });
});

// ---- Instruction decoding ----

const MOV_RSP_RBX = Buffer.from([0x48, 0x89, 0x5c, 0x24, 0x08]);
const NOP = Buffer.from([0x90]);
const RET = Buffer.from([0xc3]);

test("disasm: returns bool and does not crash", () => {
  assert.equal(typeof decodeLength, "function");
  const result = decodeLength(MOV_RSP_RBX, 0);
  assert.equal(typeof result.length, "number");
});

test("disasm: single instruction shape and size", () => {
  const insn = decodeLength(MOV_RSP_RBX, 0);
  assert.ok("length" in insn && "ripRelative" in insn);
  assert.equal(insn.length, 5);
  assert.equal(insn.ripRelative, null);
});

test("disasm: base addr offsets first instruction", () => {
  const padded = Buffer.concat([Buffer.alloc(0x10, 0x90), MOV_RSP_RBX]);
  assert.equal(decodeLength(padded, 0x10).length, 5);
});

test("disasm: two instruction sequence", () => {
  const code = Buffer.concat([MOV_RSP_RBX, NOP, RET]);
  const first = decodeLength(code, 0);
  assert.equal(first.length, 5);
  const second = decodeLength(code, first.length);
  assert.equal(second.length, 1);
  const third = decodeLength(code, first.length + second.length);
  assert.equal(third.length, 1);
  assert.ok(first.length + second.length + third.length <= code.length);
});

test("disasm: uses objdump path when capstone absent", () => {
  const lea = Buffer.from([0x48, 0x8d, 0x0d, 0x10, 0x00, 0x00, 0x00]);
  const insn = decodeLength(lea, 0);
  assert.equal(insn.length, 7);
  assert.deepEqual(insn.ripRelative, { disp: 0x10, targetOffset: 7 + 0x10 });
});

test("disasm: disasm range maps rva and disassembles", () => {
  const pe = parsePe(image);
  const insn = decodeAtRva(pe, image, meta.codeRva);
  assert.equal(insn.length, MOV_RSP_RBX.length);
});

test("disasm: disasm range unmapped rva raises", () => {
  const pe = parsePe(image);
  assert.equal(rvaToFileOffset(pe, 0xdeadbeef), null);
  assert.throws(() => decodeAtRva(pe, image, 0xdeadbeef), /not mapped/);
});

test("decodeLength covers the x64 subset and rejects unknown opcodes", () => {
  const cases = [
    ["push rbx", [0x53], 1],
    ["REX push r15", [0x41, 0x57], 2],
    ["sub rsp, imm8", [0x48, 0x83, 0xec, 0x28], 4],
    ["sub rsp, imm32", [0x48, 0x81, 0xec, 0x00, 0x01, 0x00, 0x00], 7],
    ["mov r64, imm64", [0x48, 0xb8, 1, 2, 3, 4, 5, 6, 7, 8], 10],
    ["mov r32, imm32", [0xb8, 1, 0, 0, 0], 5],
    ["mov r/m, [rsp+8] with sib and disp8", [0x48, 0x8b, 0x44, 0x24, 0x08], 5],
    ["mov r, [rax+disp32]", [0x48, 0x8b, 0x88, 0x10, 0x01, 0x00, 0x00], 7],
    ["mov dword [rcx], imm32", [0xc7, 0x01, 1, 0, 0, 0], 6],
    ["xor eax, eax", [0x31, 0xc0], 2],
    ["jz rel8", [0x74, 0x05], 2],
    ["jz rel32", [0x0f, 0x84, 1, 0, 0, 0], 6],
    ["call [rip+disp32]", [0xff, 0x15, 0x10, 0, 0, 0], 6],
    ["movzx eax, byte [rcx]", [0x0f, 0xb6, 0x01], 3],
    ["nop word [rax+rax]", [0x66, 0x0f, 0x1f, 0x44, 0x00, 0x00], 6],
    ["ret", [0xc3], 1],
  ];
  for (const [label, bytes, length] of cases) {
    assert.equal(decodeLength(Buffer.from(bytes), 0).length, length, label);
  }
  const call = decodeLength(Buffer.from([0xe8, 0x20, 0, 0, 0]), 0);
  assert.deepEqual(call.ripRelative, { disp: 0x20, targetOffset: 5 + 0x20 });
  const negative = decodeLength(Buffer.concat([Buffer.alloc(0x100), Buffer.from([0xe9, 0xf0, 0xff, 0xff, 0xff])]), 0x100);
  assert.equal(negative.ripRelative.disp, -16);
  assert.equal(negative.ripRelative.targetOffset, 0x100 + 5 - 16);
  assert.throws(() => decodeLength(Buffer.from([0x0f, 0x0b]), 0), /unsupported/);
  assert.throws(() => decodeLength(Buffer.from([0x48, 0x8b]), 0), /truncated/);
});

// ---- Signature emitters ----

const FNAME = "??0FName@@QEAA@PEB_WW4EFindName@@@Z";

test("emit_signature: satisfactory example exact format", () => {
  assert.equal(emitExport(FNAME), 'return LoadExport("??0FName@@QEAA@PEB_WW4EFindName@@@Z")\n');
});

test("emit_signature: export with comment", () => {
  const result = emitExport(FNAME, "FName constructor");
  assert.ok(result.startsWith("-- FName constructor\n"));
  assert.ok(result.includes('return LoadExport("??0FName@@QEAA@PEB_WW4EFindName@@@Z")'));
});

test("emit_signature: export no comment", () => {
  const result = emitExport(FNAME);
  assert.equal(result.startsWith("--"), false);
  assert.ok(result.startsWith("return"));
});

test("emit_signature: export ends with newline", () => {
  assert.ok(emitExport(FNAME).endsWith("\n"));
});

test("emit_signature: aob basic structure", () => {
  const aob = "48 83 EC 28";
  const result = emitAob(aob);
  for (const token of ["function Register()", `return "${aob}"`, "function OnMatchFound(MatchAddress)", "return MatchAddress", "end"]) {
    assert.ok(result.includes(token), token);
  }
});

test("emit_signature: aob indentation 4 spaces", () => {
  const lines = emitAob("48 83 EC 28").split("\n");
  const returns = lines.filter((line) => /^\s*return/.test(line));
  assert.ok(returns.length >= 2);
  for (const line of returns) assert.ok(line.startsWith("    return"), "expected 4-space indent");
});

test("emit_signature: aob with comment", () => {
  assert.ok(emitAob("48 83 EC 28", "Stack setup pattern").startsWith("-- Stack setup pattern\n"));
});

test("emit_signature: aob ends with newline", () => {
  assert.ok(emitAob("48 83 EC 28").endsWith("\n"));
});

test("emit_signature: aob multiple bytes", () => {
  for (const pattern of ["48 83 EC 28", "FF FF FF", "41 B8 01 00 00 00"]) {
    assert.ok(emitAob(pattern).includes(`return "${pattern}"`));
  }
});

const INDIRECT_AOB = "41 B8 01 00 00 00";

test("emit_signature: indirect exact format", () => {
  const result = emitIndirect(INDIRECT_AOB, 0x14, 0x05);
  assert.ok(result.includes("local InstrSize = 0x5"));
  assert.ok(result.includes("local JmpInstr = MatchAddress + 0x14"));
  assert.ok(result.includes("DerefToInt32(JmpInstr + 0x1)"));
  assert.ok(result.includes("local Destination = JmpInstr + Offset + InstrSize"));
});

test("emit_signature: indirect structure", () => {
  const result = emitIndirect(INDIRECT_AOB, 0x14, 0x05);
  for (const token of [
    "function Register()",
    `return "${INDIRECT_AOB}"`,
    "function OnMatchFound(MatchAddress)",
    "local InstrSize",
    "local JmpInstr",
    "local Offset",
    "local Destination",
    "return Destination",
  ]) {
    assert.ok(result.includes(token), token);
  }
});

test("emit_signature: indirect with comment", () => {
  const result = emitIndirect(INDIRECT_AOB, 0x14, 0x05, "GetObjectName indirect lookup");
  assert.ok(result.startsWith("-- GetObjectName indirect lookup\n"));
});

test("emit_signature: indirect decimal offsets convert to hex", () => {
  const result = emitIndirect(INDIRECT_AOB, 20, 5);
  assert.ok(result.includes("local InstrSize = 0x5"));
  assert.ok(result.includes("local JmpInstr = MatchAddress + 0x14"));
});

test("emit_signature: indirect large offset hex", () => {
  const result = emitIndirect(INDIRECT_AOB, 0x100, 0x20);
  assert.ok(result.includes("local InstrSize = 0x20"));
  assert.ok(result.includes("local JmpInstr = MatchAddress + 0x100"));
});

test("emit_signature: indirect ends with newline", () => {
  assert.ok(emitIndirect(INDIRECT_AOB, 0x14, 0x05).endsWith("\n"));
});

// These cases run `luac -p` and are skipped when luac is not on PATH.
const luac = spawnSync("luac", ["-v"], { encoding: "utf8" }).error ? null : "luac";

function validateLuaSyntax(t, code) {
  if (!luac) {
    t.skip("luac is not on PATH, so the Lua syntax is not checked");
    return;
  }
  const tmp = writeTemp(code, "sig.lua");
  try {
    const result = spawnSync(luac, ["-p", tmp.path], { encoding: "utf8" });
    assert.equal(result.status, 0, `Lua syntax error:\n${result.stderr}`);
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
}

test("emit_signature: export lua syntax valid", (t) => {
  validateLuaSyntax(t, emitExport(FNAME));
});

test("emit_signature: aob lua syntax valid", (t) => {
  validateLuaSyntax(t, emitAob("48 83 EC 28"));
});

test("emit_signature: indirect lua syntax valid", (t) => {
  validateLuaSyntax(t, emitIndirect(INDIRECT_AOB, 0x14, 0x05));
});

test("emit_signature: aob with comment lua syntax valid", (t) => {
  validateLuaSyntax(t, emitAob("48 83 EC 28", "Stack allocation"));
});

// ---- PatternSleuth log parsing ----

const PS_LOG = fs.readFileSync(fixturePath("sig", "patternsleuth.log"), "utf8");

test("ps_log_parse: engine version", () => {
  assert.equal(parsePatternSleuthLog(PS_LOG).engineVersion, "5.7");
});

test("ps_log_parse: found addresses", () => {
  const byName = Object.fromEntries(parsePatternSleuthLog(PS_LOG).resolved.map((r) => [r.name, r.offset]));
  assert.equal(byName.GUObjectArray, 0x7ff6a3f3b850);
  assert.equal(byName.GMalloc, 0x7ff6a3e62b70);
  assert.equal(byName["FName::ToString"], 0x7ff69cb38c60);
  assert.equal(byName.StaticConstructObject_Internal, 0x7ff69cd2fe10);
  assert.equal(byName.ConsoleManagerSingleton, 0x7ff69c9be500);
  assert.equal(byName.GameEngineTick, 0x7ff69f217a00);
  assert.equal("EngineVersion" in byName, false);
});

test("ps_log_parse: failed order and dedup", () => {
  assert.deepEqual(parsePatternSleuthLog(PS_LOG).unresolved, ["FName_Constructor", "GUObjectHashTables", "GNatives"]);
});

test("ps_log_parse: garbage log no crash", () => {
  const garbage = [
    "Some unrelated line",
    "2026-08-30 12:00:00 [Info] Booting engine subsystem",
    "random noise here: 12345",
    "another line without any PS markers",
    "",
  ].join("\n");
  const result = parsePatternSleuthLog(garbage);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.resolved, []);
  assert.equal(result.engineVersion, null);
});

// ---- Signature emission, pattern search and operations ----

// lea rcx,[rip+0x10] ; call rel32 ; mov [rsp+8],rbx ; ret
const FUNCTION = [0x48, 0x8d, 0x0d, 0x10, 0x00, 0x00, 0x00, 0xe8, 0x20, 0x00, 0x00, 0x00, 0x48, 0x89, 0x5c, 0x24, 0x08, 0xc3, ...new Array(0x30).fill(0)];

test("emitSignature wildcards displacements, keeps opcodes and resolves the first target", () => {
  const img = buildCodePe(FUNCTION);
  const result = emitSignature(img, RAW_OFF, { maxBytes: 32 });
  assert.equal(result.pattern, "48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? 48 89 5C 24 08 C3");
  assert.equal(result.mask, "xxx????x????xxxxxx");
  assert.deepEqual(result.matches, [RAW_OFF]);
  assert.equal(result.target, RAW_OFF + 7 + 0x10);
});

test("emitSignature stops at whole instructions inside maxBytes", () => {
  const img = buildCodePe(FUNCTION);
  const result = emitSignature(img, RAW_OFF, { maxBytes: 8 });
  assert.equal(result.pattern, "48 8D 0D ?? ?? ?? ??");
  assert.equal(result.target, RAW_OFF + 7 + 0x10);
});

test("findPattern returns file offsets and supports wildcards", () => {
  const img = buildCodePe([0x90, 0x90, 0xc3, 0x90, 0x90, 0xc3]);
  assert.deepEqual(findPattern(img, "90 90 C3"), [RAW_OFF, RAW_OFF + 3]);
  assert.deepEqual(findPattern(img, "90 ?? C3"), [RAW_OFF, RAW_OFF + 3]);
  assert.deepEqual(findPattern(img, "DE AD"), []);
});

test("unreal.pe_analyze returns sections, imports, exports and the text range", async () => {
  await withTemp(image, async (exe) => {
    const result = await executeOperation("unreal.pe_analyze", { exe });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.sections[0].name, ".text");
    assert.deepEqual(result.data.exports, ["TestExport"]);
    assert.equal(result.data.imports[0].dll, "KERNEL32.dll");
    assert.deepEqual(result.data.textRange, { start: RAW_OFF, end: RAW_OFF + meta.rawSize });
    assert.deepEqual(result.effects, ["read"]);
    assert.equal(result.gate, "auto");
  });
});

test("unreal.aob_emit returns a unique pattern and refuses an ambiguous one with GMF-E-SIG-001", async () => {
  const unique = writeTemp(buildCodePe(FUNCTION));
  const ambiguous = writeTemp(buildCodePe([0x90, 0x90, 0xc3, 0x90, 0x90, 0xc3]));
  try {
    const ok = await executeOperation("unreal.aob_emit", { exe: unique.path, offset: RAW_OFF });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.data.matches.length, 1);
    assert.equal(ok.data.target, RAW_OFF + 7 + 0x10);

    const bad = await executeOperation("unreal.aob_emit", { exe: ambiguous.path, offset: RAW_OFF, maxBytes: 2 });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "GMF-E-SIG-001");
    assert.match(bad.error.message, /\b2\b/);
  } finally {
    fs.rmSync(unique.dir, { recursive: true, force: true });
    fs.rmSync(ambiguous.dir, { recursive: true, force: true });
  }
});

test("unreal.aob_verify returns the match count and offsets", async () => {
  await withTemp(buildCodePe([0x90, 0x90, 0xc3, 0x90, 0x90, 0xc3]), async (exe) => {
    const result = await executeOperation("unreal.aob_verify", { exe, pattern: "90 90 C3" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.count, 2);
    assert.deepEqual(result.data.offsets, [RAW_OFF, RAW_OFF + 3]);
    const none = await executeOperation("unreal.aob_verify", { exe, pattern: "DE AD" });
    assert.equal(none.data.count, 0);
  });
});

// ---- Edge cases: ret detection, RIP targets across sections, operand size with REX.W ----

test("emitSignature does not end the pattern at an instruction whose last byte is C3", () => {
  const code = [0x48, 0x89, 0xc3, 0x48, 0x83, 0xec, 0x28, 0x90, 0x90, 0x90, 0x90];
  assert.equal(emitSignature(buildCodePe(code), RAW_OFF, { maxBytes: 32 }).pattern, "48 89 C3 48 83 EC 28 90 90 90 90");
  assert.equal(emitSignature(buildCodePe([0xb0, 0xc3, 0x90, 0x90]), RAW_OFF, { maxBytes: 32 }).pattern, "B0 C3 90 90");
});

test("emitSignature ends the pattern at ret, ret imm16 and repz ret", () => {
  assert.equal(emitSignature(buildCodePe([0x90, 0xc3, 0x90]), RAW_OFF).pattern, "90 C3");
  assert.equal(emitSignature(buildCodePe([0x90, 0xc2, 0x08, 0x00, 0x90]), RAW_OFF).pattern, "90 C2 08 00");
  assert.equal(emitSignature(buildCodePe([0x90, 0xf3, 0xc3, 0x90]), RAW_OFF).pattern, "90 F3 C3");
});

test("decodeLength: 66 REX.W 81 /0 takes a 4-byte immediate", () => {
  assert.equal(decodeLength(Buffer.from([0x66, 0x48, 0x81, 0xc0, 1, 2, 3, 4, 0x90]), 0).length, 8);
  assert.equal(decodeLength(Buffer.from([0x66, 0x81, 0xc0, 1, 2, 0x90]), 0).length, 5);
});

// .text at RVA 0x1000 / file 0x200 and .rdata at RVA 0x3000 / file 0x280: the two deltas differ.
function buildTwoSectionPe() {
  const img = Buffer.from(buildPeTwoExec());
  const second = SEC_TABLE_OFF + 40;
  img.write(".rdata\0\0", second, "latin1");
  img.writeUInt32LE(0x3000, second + 12);
  img.writeUInt32LE(MEM_READ, second + 36);
  // lea rcx, [rip + 0x2009] at RVA 0x1000; next instruction RVA 0x1007; target RVA 0x3010.
  Buffer.from([0x48, 0x8d, 0x0d, 0x09, 0x20, 0x00, 0x00, 0xc3]).copy(img, RAW_OFF);
  return img;
}

test("RIP-relative targets map through the RVA to the file offset of the target section", () => {
  const img = buildTwoSectionPe();
  const pe = parsePe(img);
  assert.equal(rvaToFileOffset(pe, 0x3010), RAW_OFF + 0x80 + 0x10);
  assert.equal(decodeAtRva(pe, img, 0x1000).ripRelative.targetOffset, 0x290);
  assert.equal(emitSignature(img, RAW_OFF).target, 0x290);
});

test("a RIP-relative target outside every section is reported as null", () => {
  const img = buildTwoSectionPe();
  img.writeUInt32LE(0x7000, RAW_OFF + 3);
  assert.equal(emitSignature(img, RAW_OFF).target, null);
});
