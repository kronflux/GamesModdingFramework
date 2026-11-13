import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disassemble, KismetError, loadNames, loadPointers, pyFloat } from "../src/engines/unreal/docs/kismet.mjs";

const POINTERS = new Map([
  [0x1000n, "/Game/Demo/BP_Sword.BP_Sword_C:ExecuteUbergraph_BP_Sword"],
  [0x2000n, "/Game/Demo/BP_Sword.BP_Sword_C:ExecuteUbergraph_BP_Sword:EntryPoint"],
  [0x3000n, "/Game/Demo/BP_Sword.BP_Sword_C:Damage"],
  [0x4000n, "/Script/Engine.KismetMathLibrary:Add_IntInt"],
  [0x5000n, "/Game/Demo/BP_Sword.BP_Sword_C:Target"],
  [0x6000n, "/Script/Demo.Item"],
]);
const NAMES = [];
NAMES[77] = "PlayEffect";
NAMES[78] = "Glow";

function bytes(...parts) {
  const out = [];
  for (const part of parts) out.push(...(typeof part === "number" ? [part] : part));
  return Uint8Array.from(out);
}

function ptr(address) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(address), true);
  return new Uint8Array(view.buffer);
}

function u32(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value, true);
  return new Uint8Array(view.buffer);
}

function i32(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, value, true);
  return new Uint8Array(view.buffer);
}

function name(index, number = 0) {
  return bytes(u32(index), u32(index), u32(number));
}

function intConst(value) {
  return bytes(0x1d, i32(value));
}

const RETURN_NOTHING = bytes(0x04, 0x0b);
const END = bytes(0x53);
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

function lines(data) {
  const { statements, unresolved } = disassemble(data, POINTERS, NAMES);
  return [statements.map((s) => `${hex4(s.offset)}: ${s.text}`), unresolved];
}

test("an event stub calls the ubergraph with its entry offset in hex", () => {
  const data = bytes(0x46, ptr(0x1000), intConst(10), 0x16, RETURN_NOTHING, END);
  assert.deepEqual(lines(data), [["0000: BP_Sword_C::ExecuteUbergraph_BP_Sword(0x000A)", "000F: return"], 0]);
  const { statements } = disassemble(data, POINTERS, NAMES);
  assert.deepEqual(statements.map((s) => s.op), ["EX_LocalFinalFunction", "EX_Return"]);
});

test("assignment, math call and names", () => {
  const let_ = bytes(0x0f, ptr(0x3000), 0x01, ptr(0x3000), 0x68, ptr(0x4000), 0x01, ptr(0x3000), intConst(5), 0x16);
  const call = bytes(0x1b, name(77), 0x21, name(78, 3), 0x16);
  const [out, unresolved] = lines(bytes(let_, call, RETURN_NOTHING, END));
  assert.equal(out[0], "0000: self.Damage = KismetMathLibrary::Add_IntInt(self.Damage, 5)");
  assert.equal(out[1], `${hex4(let_.length)}: PlayEffect(name("Glow_2"))`);
  assert.equal(unresolved, 0);
});

test("a call on another object reads as member access", () => {
  const context = bytes(0x19, 0x01, ptr(0x5000), u32(0), ptr(0), 0x01, ptr(0x3000));
  const data = bytes(0x0f, ptr(0x3000), 0x00, ptr(0x2000), context, END);
  assert.deepEqual(lines(data)[0], ["0000: EntryPoint = self.Target.Damage"]);
});

test("jumps, casts and constants", () => {
  const jumpIf = bytes(0x07, u32(0x40), 0x27);
  const cast = bytes(0x0f, ptr(0x5000), 0x01, ptr(0x5000), 0x2e, ptr(0x6000), 0x17);
  const text = bytes(0x0f, ptr(0), 0x00, ptr(0x2000), 0x1f, [0x68, 0x69, 0x00]);
  const data = bytes(jumpIf, cast, text, 0x06, u32(0), END);
  const [out] = lines(data);
  assert.equal(out[0], "0000: if not (true) goto 0x0040");
  assert.equal(out[1], "0006: self.Target = cast<Item>(self)");
  assert.ok(out[2].endsWith('EntryPoint = "hi"'), out[2]);
  assert.ok(out[3].endsWith("goto 0x0000"), out[3]);
  const { statements } = disassemble(data, POINTERS, NAMES);
  assert.equal(statements[0].op, "EX_JumpIfNot");
  assert.equal(statements[0].target, 0x40);
  assert.equal(statements[3].op, "EX_Jump");
  assert.equal(statements[3].target, 0);
  assert.equal(statements[1].target, undefined);
});

test("push execution flow carries its target", () => {
  const { statements } = disassemble(bytes(0x4c, u32(0x1234), 0x4d, END), POINTERS, NAMES);
  assert.deepEqual(statements, [
    { offset: 0, text: "push 0x1234", op: "EX_PushExecutionFlow", target: 0x1234 },
    { offset: 5, text: "pop", op: "EX_PopExecutionFlow" },
  ]);
});

test("a reference that is not in the dump is shown as its address and counted", () => {
  const [out, unresolved] = lines(bytes(0x46, ptr(0x9999), 0x16, 0x21, name(5), END));
  assert.ok(out[0].includes("<0x9999>"), out[0]);
  assert.ok(out[1].includes("<name 5>"), out[1]);
  assert.equal(unresolved, 2);
});

test("refs and called names are filled", () => {
  const refs = new Set();
  const called = new Set();
  const data = bytes(0x1b, name(77), 0x01, ptr(0x3000), 0x16, END);
  disassemble(data, POINTERS, NAMES, refs, called);
  assert.deepEqual([...refs], ["/Game/Demo/BP_Sword.BP_Sword_C:Damage"]);
  assert.deepEqual([...called], ["PlayEffect"]);
});

test("bytes that do not decode to their exact length are refused", () => {
  assert.throws(() => disassemble(bytes(0x46, ptr(0x1000), 0x16), POINTERS, NAMES), KismetError); // no end marker
  assert.throws(() => disassemble(bytes(RETURN_NOTHING, END, 0x0b), POINTERS, NAMES), KismetError); // bytes after the end
  assert.throws(() => disassemble(bytes(0xee, END), POINTERS, NAMES), KismetError); // unknown opcode
  assert.throws(() => disassemble(bytes(0x1d, 0x01), POINTERS, NAMES), KismetError); // cut short
});

test("a truncated stream throws KismetError with the offset", () => {
  const data = bytes(RETURN_NOTHING, 0x1d, 0x01, 0x02);
  assert.throws(() => disassemble(data, POINTERS, NAMES), (error) => {
    assert.ok(error instanceof KismetError);
    assert.equal(error.offset, 3);
    assert.equal(error.message, "read past the end at 0x0003");
    return true;
  });
});

test("unknown opcode 0xFE throws KismetError", () => {
  assert.throws(() => disassemble(bytes(RETURN_NOTHING, 0xfe, END), POINTERS, NAMES), (error) => {
    assert.ok(error instanceof KismetError);
    assert.equal(error.offset, 2);
    assert.equal(error.message, "unknown opcode 0xFE at 0x0002");
    return true;
  });
});

test("float constants print as Python format(value, '.7g')", () => {
  const f32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return new Uint8Array(b.buffer); };
  const { statements } = disassemble(bytes(0x04, 0x1e, f32(0.1), END), POINTERS, NAMES);
  assert.equal(statements[0].text, "return 0.1");
});

test("pyFloat matches Python format(value, '.7g')", () => {
  // Expected strings were produced by CPython's format(value, ".7g").
  const cases = [
    [1.0, "1"], [0.0, "0"], [-0.0, "-0"], [1e-05, "1e-05"], [0.0001, "0.0001"], [123456.7, "123456.7"],
    [1234567.0, "1234567"], [12345678.0, "1.234568e+07"], [1234567.5, "1234568"], [1234568.5, "1234568"],
    [0.1, "0.1"], [Infinity, "inf"], [-Infinity, "-inf"], [NaN, "nan"], [-2.5, "-2.5"], [1e100, "1e+100"],
    [5e-324, "4.940656e-324"], [Math.fround(0.1), "0.1"], [100.0, "100"], [1e7, "1e+07"], [9999999.5, "1e+07"],
    [0.00012345675, "0.0001234567"],
  ];
  for (const [value, expected] of cases) assert.equal(pyFloat(value), expected, `pyFloat(${value})`);
});

test("lookups are read from the dump files", () => {
  const temp = mkdtempSync(join(tmpdir(), "kismet-"));
  try {
    const dump = join(temp, "dump.txt");
    writeFileSync(dump, "[0000000000001000] Function /Game/A.A_C:Run [n: 1] [c: 2]\n"
      + "[0000000000000000] World [n: 8EA] [v: 0]\n"
      + "not an object line\n");
    const csv = join(temp, "fnames.csv");
    writeFileSync(csv, 'index,number,name\n77,0,PlayEffect\n78,0,"a,b"\n');
    const pointers = loadPointers(dump);
    assert.equal(pointers.get(0x1000n), "/Game/A.A_C:Run");
    // Same as the Python loader: a line without a path keeps the first bracket as its path.
    assert.deepEqual([...pointers], [[0x1000n, "/Game/A.A_C:Run"], [0n, "[n: 8EA]"]]);
    const names = loadNames(csv);
    assert.deepEqual(Object.entries(names), [["77", "PlayEffect"], ["78", "a,b"]]);
    const merged = loadNames(csv, '{"type":"Names","names":{"78":"other","79":"Extra"}}');
    assert.equal(merged[78], "a,b");
    assert.equal(merged[79], "Extra");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
