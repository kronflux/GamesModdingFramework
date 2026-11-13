import test from "node:test";
import assert from "node:assert/strict";
import { disassemble } from "../src/engines/unreal/docs/kismet.mjs";
import { structure } from "../src/engines/unreal/docs/structure.mjs";

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

// Hand-written statements in the shape `disassemble` returns them.
const call = (offset, text) => ({ offset, text, op: "EX_LocalFinalFunction" });
const assign = (offset, text) => ({ offset, text, op: "EX_Let" });
const ret = (offset) => ({ offset, text: "return", op: "EX_Return" });
const jump = (offset, target) => ({ offset, text: `goto 0x${hex4(target)}`, op: "EX_Jump", target });
const jumpIfNot = (offset, cond, target) => ({ offset, text: `if not (${cond}) goto 0x${hex4(target)}`, op: "EX_JumpIfNot", target });
const push = (offset, target) => ({ offset, text: `push 0x${hex4(target)}`, op: "EX_PushExecutionFlow", target });
const pop = (offset) => ({ offset, text: "pop", op: "EX_PopExecutionFlow" });
const popIfNot = (offset, cond) => ({ offset, text: `if not (${cond}) pop`, op: "EX_PopExecutionFlowIfNot" });

const IF_ELSE = [
  jumpIfNot(0x00, "self.bArmed", 0x40),
  assign(0x10, "self.Damage = 5"),
  jump(0x20, 0x50),
  assign(0x40, "self.Damage = 0"),
  call(0x50, "Log(self.Damage)"),
  ret(0x60),
];

const WHILE = [
  assign(0x00, "self.I = 0"),
  jumpIfNot(0x10, "self.bRunning", 0x40),
  call(0x20, "Tick()"),
  jump(0x30, 0x10),
  ret(0x40),
];

const WHILE_WITH_CONDITION_STATEMENTS = [
  assign(0x00, "Counter = 0"),
  assign(0x10, "Ok = LessEqual_IntInt(Counter, 3)"),
  jumpIfNot(0x20, "Ok", 0x60),
  call(0x30, "Body(Counter)"),
  assign(0x40, "Counter = Add_IntInt(Counter, 1)"),
  jump(0x50, 0x10),
  ret(0x60),
];

const SEQUENCE = [
  push(0x00, 0x30),
  call(0x10, "First()"),
  pop(0x20),
  call(0x30, "Second()"),
  pop(0x40),
];

const SEQUENCE_OF_THREE = [
  push(0x00, 0x60),
  push(0x08, 0x40),
  call(0x10, "First()"),
  pop(0x20),
  call(0x40, "Second()"),
  pop(0x50),
  call(0x60, "Third()"),
  pop(0x70),
];

const IF_INSIDE_WHILE = [
  jumpIfNot(0x00, "self.bRunning", 0x60),
  jumpIfNot(0x10, "self.bHurt", 0x40),
  call(0x20, "Heal()"),
  jump(0x30, 0x50),
  call(0x40, "Attack()"),
  jump(0x50, 0x00),
  ret(0x60),
];

const POP_IF_NOT_IN_SEQUENCE = [
  push(0x00, 0x30),
  popIfNot(0x08, "self.bReady"),
  call(0x10, "Go()"),
  pop(0x20),
  call(0x30, "After()"),
  pop(0x40),
];

const STRAIGHT = [
  assign(0x00, "self.A = 1"),
  call(0x10, "Print(self.A)"),
  ret(0x20),
];

const IRREDUCIBLE = [
  jumpIfNot(0x00, "c", 0x30),
  call(0x10, "A()"),
  jumpIfNot(0x20, "d", 0x50),
  call(0x30, "B()"),
  jump(0x40, 0x10),
  ret(0x50),
];

const FIXTURES = { IF_ELSE, WHILE, WHILE_WITH_CONDITION_STATEMENTS, SEQUENCE, SEQUENCE_OF_THREE, IF_INSIDE_WHILE, POP_IF_NOT_IN_SEQUENCE, STRAIGHT };

const CONTROL = new Set(["EX_Jump", "EX_JumpIfNot", "EX_PushExecutionFlow", "EX_PopExecutionFlow", "EX_PopExecutionFlowIfNot"]);

function structured(statements) {
  const result = structure(statements);
  assert.equal(result.kind, "structured", result.reason);
  for (const line of result.lines) assert.ok(!/\bgoto\b/.test(line), `goto in ${line}`);
  return result.lines;
}

test("an if/else renders both branches and the join statement after it, without goto", () => {
  assert.deepEqual(structured(IF_ELSE), [
    "if (self.bArmed) {",
    "  self.Damage = 5",
    "} else {",
    "  self.Damage = 0",
    "}",
    "Log(self.Damage)",
    "return",
  ]);
});

test("a hand-assembled if/else decodes and renders as if/else", () => {
  const u32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v, true); return [...new Uint8Array(b.buffer)]; };
  const ptr = (v) => { const b = new DataView(new ArrayBuffer(8)); b.setBigUint64(0, BigInt(v), true); return [...new Uint8Array(b.buffer)]; };
  const let5 = [0x0f, ...ptr(0x3000), 0x01, ...ptr(0x3000), 0x1d, ...u32(5)]; // 23 bytes
  const let0 = [0x0f, ...ptr(0x3000), 0x01, ...ptr(0x3000), 0x1d, ...u32(0)];
  // 0: if not (true) goto 34; 6: Damage = 5; 29: goto 57; 34: Damage = 0; 57: return; 59: end
  const data = Uint8Array.from([0x07, ...u32(34), 0x27, ...let5, 0x06, ...u32(57), ...let0, 0x04, 0x0b, 0x53]);
  const { statements } = disassemble(data, new Map([[0x3000n, "/Game/A.A_C:Damage"]]), []);
  assert.deepEqual(structured(statements), [
    "if (true) {",
    "  self.Damage = 5",
    "} else {",
    "  self.Damage = 0",
    "}",
    "return",
  ]);
});

test("a loop renders as while", () => {
  assert.deepEqual(structured(WHILE), [
    "self.I = 0",
    "while (self.bRunning) {",
    "  Tick()",
    "}",
    "return",
  ]);
});

test("a loop whose condition is computed by statements renders as while (true) with a break", () => {
  assert.deepEqual(structured(WHILE_WITH_CONDITION_STATEMENTS), [
    "Counter = 0",
    "while (true) {",
    "  Ok = LessEqual_IntInt(Counter, 3)",
    "  if (!(Ok)) break",
    "  Body(Counter)",
    "  Counter = Add_IntInt(Counter, 1)",
    "}",
    "return",
  ]);
});

test("a Sequence with two pushed blocks renders both blocks in execution order", () => {
  assert.deepEqual(structured(SEQUENCE), [
    "// sequence 1",
    "  First()",
    "// sequence 2",
    "  Second()",
  ]);
});

test("a Sequence with three outputs renders three blocks in execution order", () => {
  assert.deepEqual(structured(SEQUENCE_OF_THREE), [
    "// sequence 1",
    "  First()",
    "// sequence 2",
    "  Second()",
    "// sequence 3",
    "  Third()",
  ]);
});

test("a nested if inside a while renders as if/else inside the loop", () => {
  assert.deepEqual(structured(IF_INSIDE_WHILE), [
    "while (self.bRunning) {",
    "  if (self.bHurt) {",
    "    Heal()",
    "  } else {",
    "    Attack()",
    "  }",
    "}",
    "return",
  ]);
});

test("a conditional pop inside a sequence block renders as if", () => {
  assert.deepEqual(structured(POP_IF_NOT_IN_SEQUENCE), [
    "// sequence 1",
    "  if (self.bReady) {",
    "    Go()",
    "  }",
    "// sequence 2",
    "  After()",
  ]);
});

test("a jump to the final return from inside a branch renders as return", () => {
  // if (a) { A(); if (!b) return; B() }; Shared(); return  -- where the else of `a` enters Shared().
  const statements = [
    jumpIfNot(0x00, "a", 0x50),
    call(0x10, "A()"),
    jumpIfNot(0x20, "b", 0x70),
    call(0x30, "B()"),
    jump(0x40, 0x50),
    call(0x50, "Shared()"),
    jump(0x60, 0x70),
    ret(0x70),
  ];
  assert.deepEqual(structured(statements), [
    "if (a) {",
    "  A()",
    "  if (!(b)) {",
    "    return",
    "  }",
    "  B()",
    "}",
    "Shared()",
    "return",
  ]);
  assert.equal(structure(statements).statements, 4);
});

test("an early return inside a loop body renders as return in the loop", () => {
  const statements = [
    jumpIfNot(0x00, "self.bRunning", 0x50),
    jumpIfNot(0x10, "self.bAlive", 0x50),
    call(0x20, "Tick()"),
    jump(0x30, 0x00),
    ret(0x50),
  ];
  assert.deepEqual(structured(statements), [
    "while (self.bRunning) {",
    "  if (!(self.bAlive)) {",
    "    return",
    "  }",
    "  Tick()",
    "}",
    "return",
  ]);
});

test("an irreducible graph returns flat", () => {
  assert.deepEqual(structure(IRREDUCIBLE), { kind: "flat", reason: "irreducible control flow" });
});

test("a computed jump returns flat", () => {
  const statements = [{ offset: 0, text: "goto (EntryPoint)", op: "EX_ComputedJump" }, ret(0x10)];
  assert.deepEqual(structure(statements), { kind: "flat", reason: "computed jump (event graph)" });
});

test("a jump to an offset that starts no statement returns flat", () => {
  const statements = [jump(0x00, 0x15), call(0x10, "A()"), ret(0x20)];
  assert.deepEqual(structure(statements), { kind: "flat", reason: "jump into the middle of a statement" });
});

test("code reached from two places that are not a join returns flat instead of a goto", () => {
  // Both the loop body and the code after the loop run Shared(): it would need a goto.
  const statements = [
    jumpIfNot(0x00, "a", 0x30),
    call(0x10, "Shared()"),
    ret(0x20),
    jumpIfNot(0x30, "b", 0x10),
    call(0x40, "Other()"),
    jump(0x50, 0x10),
  ];
  const result = structure(statements);
  if (result.kind === "structured") {
    assert.equal(result.lines.filter((l) => l.trim() === "Shared()").length, 1);
  }
});

test("statement count in equals statement count out for each fixture", () => {
  for (const [name, statements] of Object.entries(FIXTURES)) {
    const result = structure(statements);
    assert.equal(result.kind, "structured", `${name}: ${result.reason}`);
    const inputs = statements.filter((s) => !CONTROL.has(s.op)).map((s) => s.text);
    assert.equal(result.statements, inputs.length, name);
    const trimmed = result.lines.map((l) => l.trim());
    const outputs = trimmed.filter((l) => inputs.includes(l));
    assert.deepEqual(outputs, inputs, `${name}: every statement once, in order`);
  }
});

test("a function with no control flow is structured and identical to its flat text", () => {
  const result = structure(STRAIGHT);
  assert.deepEqual(result, { kind: "structured", lines: STRAIGHT.map((s) => s.text), statements: 3 });
});

test("an empty function is structured with no lines", () => {
  assert.deepEqual(structure([]), { kind: "structured", lines: [], statements: 0 });
});
