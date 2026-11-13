// Turns Blueprint bytecode, as it sits in the game's memory, into readable statements.
//
// The bytes come from Scripts/bytecode.jsonl of a dumper run. In memory, a reference to an
// object or a property is an 8-byte pointer and a name is a 12-byte FScriptName (comparison
// index, display index, number), so the caller supplies two lookups made from the same run:
// `pointers` maps an address (a BigInt) to the object's path, built from
// Objects/UE4SS_ObjectDump.txt, and `names` maps a name index to its text, built from
// Names/fnames.csv plus the Names record of bytecode.jsonl.
//
// The opcode table is the engine's EExprToken for Unreal Engine 5. Every function must decode
// to exactly its recorded size; `disassemble` throws KismetError when it does not, so a wrong
// table shows up at once instead of as plausible nonsense.
//
// The statement text is kept byte-identical to the Python decoder this format was first
// written in (tools/kismet.py of OmniDumper), including its number formatting, because the
// generated documentation is compared against that decoder's output.

import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export class KismetError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = "KismetError";
    this.offset = offset;
  }
}

const END_FUNCTION_PARMS = 0x16;
const END_OF_SCRIPT = 0x53;

const CAST_NAMES = new Map([
  [0x00, "object_to_interface"], [0x41, "object_to_interface"], [0x46, "object_to_bool"], [0x47, "interface_to_bool"],
  [0x49, "double_to_float"], [0x4a, "float_to_double"],
]);

/** EExprToken names (Unreal Engine 5), by opcode. */
export const OPCODE_NAMES = new Map([
  [0x00, "EX_LocalVariable"], [0x01, "EX_InstanceVariable"], [0x02, "EX_DefaultVariable"], [0x04, "EX_Return"],
  [0x06, "EX_Jump"], [0x07, "EX_JumpIfNot"], [0x09, "EX_Assert"], [0x0b, "EX_Nothing"], [0x0c, "EX_NothingInt32"],
  [0x0f, "EX_Let"], [0x11, "EX_BitFieldConst"], [0x12, "EX_ClassContext"], [0x13, "EX_MetaCast"],
  [0x14, "EX_LetBool"], [0x15, "EX_EndParmValue"], [0x16, "EX_EndFunctionParms"], [0x17, "EX_Self"],
  [0x18, "EX_Skip"], [0x19, "EX_Context"], [0x1a, "EX_Context_FailSilent"], [0x1b, "EX_VirtualFunction"],
  [0x1c, "EX_FinalFunction"], [0x1d, "EX_IntConst"], [0x1e, "EX_FloatConst"], [0x1f, "EX_StringConst"],
  [0x20, "EX_ObjectConst"], [0x21, "EX_NameConst"], [0x22, "EX_RotationConst"], [0x23, "EX_VectorConst"],
  [0x24, "EX_ByteConst"], [0x25, "EX_IntZero"], [0x26, "EX_IntOne"], [0x27, "EX_True"], [0x28, "EX_False"],
  [0x29, "EX_TextConst"], [0x2a, "EX_NoObject"], [0x2b, "EX_TransformConst"], [0x2c, "EX_IntConstByte"],
  [0x2d, "EX_NoInterface"], [0x2e, "EX_DynamicCast"], [0x2f, "EX_StructConst"], [0x30, "EX_EndStructConst"],
  [0x31, "EX_SetArray"], [0x32, "EX_EndArray"], [0x33, "EX_PropertyConst"], [0x34, "EX_UnicodeStringConst"],
  [0x35, "EX_Int64Const"], [0x36, "EX_UInt64Const"], [0x37, "EX_DoubleConst"], [0x38, "EX_Cast"],
  [0x39, "EX_SetSet"], [0x3a, "EX_EndSet"], [0x3b, "EX_SetMap"], [0x3c, "EX_EndMap"], [0x3d, "EX_SetConst"],
  [0x3e, "EX_EndSetConst"], [0x3f, "EX_MapConst"], [0x40, "EX_EndMapConst"], [0x41, "EX_Vector3fConst"],
  [0x42, "EX_StructMemberContext"], [0x43, "EX_LetMulticastDelegate"], [0x44, "EX_LetDelegate"],
  [0x45, "EX_LocalVirtualFunction"], [0x46, "EX_LocalFinalFunction"], [0x48, "EX_LocalOutVariable"],
  [0x4a, "EX_DeprecatedOp4A"], [0x4b, "EX_InstanceDelegate"], [0x4c, "EX_PushExecutionFlow"],
  [0x4d, "EX_PopExecutionFlow"], [0x4e, "EX_ComputedJump"], [0x4f, "EX_PopExecutionFlowIfNot"],
  [0x50, "EX_Breakpoint"], [0x51, "EX_InterfaceContext"], [0x52, "EX_ObjToInterfaceCast"],
  [0x53, "EX_EndOfScript"], [0x54, "EX_CrossInterfaceCast"], [0x55, "EX_InterfaceToObjCast"],
  [0x5a, "EX_WireTracepoint"], [0x5b, "EX_SkipOffsetConst"], [0x5c, "EX_AddMulticastDelegate"],
  [0x5d, "EX_ClearMulticastDelegate"], [0x5e, "EX_Tracepoint"], [0x5f, "EX_LetObj"], [0x60, "EX_LetWeakObjPtr"],
  [0x61, "EX_BindDelegate"], [0x62, "EX_RemoveMulticastDelegate"], [0x63, "EX_CallMulticastDelegate"],
  [0x64, "EX_LetValueOnPersistentFrame"], [0x65, "EX_ArrayConst"], [0x66, "EX_EndArrayConst"],
  [0x67, "EX_SoftObjectConst"], [0x68, "EX_CallMath"], [0x69, "EX_SwitchValue"], [0x6a, "EX_InstrumentationEvent"],
  [0x6b, "EX_ArrayGetByRef"], [0x6c, "EX_ClassSparseDataVariable"], [0x6d, "EX_FieldPathConst"],
]);

/** Top-level instructions whose first operand is a jump offset (u32). */
const JUMP_OPCODES = new Set([0x06, 0x07, 0x4c]);

// --- Python-compatible formatting

/** Python's format(n, "04X") for an integer (number or BigInt), sign included in the width. */
function hex4(value) {
  const n = BigInt(value);
  const digits = (n < 0n ? -n : n).toString(16).toUpperCase();
  return n < 0n ? "-" + digits.padStart(3, "0") : digits.padStart(4, "0");
}

/**
 * The text Python's format(value, ".7g") gives for a float: seven significant digits,
 * rounded half to even on the exact binary value, trailing zeros removed, scientific
 * notation below 1e-4 and from 1e7, a two-digit exponent at least ("1e-05", "1.234568e+07").
 */
export function pyFloat(value, precision = 7) {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  const negative = value < 0 || Object.is(value, -0);
  const sign = negative ? "-" : "";
  if (value === 0) return sign + "0";

  // Exact decimal expansion: |value| = digits * 10^-scale.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exponent;
  if (biased === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  let digits;
  let scale;
  if (exponent >= 0) {
    digits = (mantissa << BigInt(exponent)).toString();
    scale = 0;
  } else {
    digits = (mantissa * 5n ** BigInt(-exponent)).toString();
    scale = -exponent;
  }
  let sciExp = digits.length - 1 - scale;

  // Round to `precision` significant digits, half to even.
  let head;
  if (digits.length <= precision) {
    head = digits.padEnd(precision, "0");
  } else {
    head = digits.slice(0, precision);
    const rest = digits.slice(precision);
    const first = rest.charCodeAt(0) - 48;
    let up = false;
    if (first > 5) up = true;
    else if (first === 5) {
      up = /[1-9]/.test(rest.slice(1)) || (head.charCodeAt(precision - 1) - 48) % 2 === 1;
    }
    if (up) {
      head = (BigInt(head) + 1n).toString();
      if (head.length > precision) {
        head = head.slice(0, precision);
        sciExp += 1;
      }
    }
  }

  if (sciExp >= -4 && sciExp < precision) {
    let intPart;
    let frac;
    if (sciExp >= 0) {
      intPart = head.slice(0, sciExp + 1);
      frac = head.slice(sciExp + 1);
    } else {
      intPart = "0";
      frac = "0".repeat(-sciExp - 1) + head;
    }
    frac = frac.replace(/0+$/, "");
    return sign + intPart + (frac ? "." + frac : "");
  }
  let mant = head[0];
  const tail = head.slice(1).replace(/0+$/, "");
  if (tail) mant += "." + tail;
  const expSign = sciExp < 0 ? "-" : "+";
  return sign + mant + "e" + expSign + String(Math.abs(sciExp)).padStart(2, "0");
}

/** "/Script/Engine.KismetMathLibrary:Add_IntInt" becomes "KismetMathLibrary::Add_IntInt". */
function shortFunction(path) {
  const colon = path.lastIndexOf(":");
  const owner = colon < 0 ? "" : path.slice(0, colon);
  const name = colon < 0 ? "" : path.slice(colon + 1);
  if (!owner) return lastAfter(path, ".");
  return lastAfter(lastAfter(owner, "."), ":") + "::" + name;
}

function lastAfter(text, separator) {
  const at = text.lastIndexOf(separator);
  return at < 0 ? text : text.slice(at + separator.length);
}

function leaf(path) {
  return lastAfter(path.replaceAll(":", "."), ".");
}

function quote(text) {
  return '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r") + '"';
}

function latin1(data, start, end) {
  let out = "";
  for (let i = start; i < end; i += 8192) {
    out += String.fromCharCode.apply(null, data.subarray(i, Math.min(end, i + 8192)));
  }
  return out;
}

const UTF16 = new TextDecoder("utf-16le");

// --- the reader

class Disassembler {
  constructor(data, pointers, names, refs, calledNames) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = 0;
    this.pointers = pointers;
    this.names = names;
    this.unresolved = 0;
    this.refs = refs;
    this.calledNames = calledNames;
  }

  need(size) {
    if (this.pos + size > this.data.length) {
      throw new KismetError(`read past the end at 0x${hex4(this.pos)}`, this.pos);
    }
  }

  u8() { this.need(1); return this.data[this.pos++]; }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return v; }
  u64() { this.need(8); const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  number(value) {
    return pyFloat(value);
  }

  /** The path the pointer names, null for a null pointer, or a placeholder when unknown. */
  pointer() {
    const address = this.u64();
    if (address === 0n) return null;
    const found = this.pointers.get(address);
    if (found === undefined) {
      this.unresolved += 1;
      return `<0x${address.toString(16).toUpperCase()}>`;
    }
    if (this.refs) this.refs.add(found);
    return found;
  }

  /** An FScriptName: comparison index, display index, number. */
  name() {
    this.need(12);
    const index = this.view.getUint32(this.pos, true);
    const number = this.view.getUint32(this.pos + 8, true);
    this.pos += 12;
    let text = this.names instanceof Map ? this.names.get(index) : this.names[index];
    if (text === undefined) {
      this.unresolved += 1;
      text = `<name ${index}>`;
    }
    return number ? `${text}_${number - 1}` : text;
  }

  ansi() {
    const end = this.data.indexOf(0, this.pos);
    if (end < 0) throw new KismetError("string without an end", this.pos);
    const text = latin1(this.data, this.pos, end);
    this.pos = end + 1;
    return text;
  }

  utf16() {
    const start = this.pos;
    for (;;) {
      if (this.pos + 2 > this.data.length) throw new KismetError("string without an end", start);
      const unit = this.view.getUint16(this.pos, true);
      this.pos += 2;
      if (unit === 0) break;
    }
    return UTF16.decode(this.data.subarray(start, this.pos - 2));
  }

  // --- named reads
  prop() {
    const found = this.pointer();
    return found === null ? "null" : leaf(found);
  }

  function() {
    const found = this.pointer();
    return found === null ? "null" : shortFunction(found);
  }

  typeName() {
    const found = this.pointer();
    return found === null ? "null" : leaf(found);
  }

  args() {
    const out = [];
    for (;;) {
      if (this.pos >= this.data.length) throw new KismetError("call without an end", this.pos);
      if (this.data[this.pos] === END_FUNCTION_PARMS) {
        this.pos += 1;
        return out;
      }
      out.push(this.expr());
    }
  }

  until(end) {
    const out = [];
    for (;;) {
      if (this.pos >= this.data.length) throw new KismetError("list without an end", this.pos);
      if (this.data[this.pos] === end) {
        this.pos += 1;
        return out;
      }
      out.push(this.expr());
    }
  }

  call(name, args) {
    if (lastAfter(name, "::").startsWith("ExecuteUbergraph") && args.length === 1 && /^[0-9]+$/.test(args[0].replace(/^-+/, ""))) {
      return `${name}(0x${hex4(BigInt(args[0]))})`;
    }
    return `${name}(${args.join(", ")})`;
  }

  context(opcode) {
    const target = this.expr();
    this.u32();
    this.pointer();
    let inner = this.expr();
    if (inner.startsWith("self.")) inner = inner.slice(5);
    return `${target}${opcode === 0x1a ? "?." : "."}${inner}`;
  }

  textConst() {
    const kind = this.u8();
    if (kind === 0) return 'text("")';
    if (kind === 1) {
      const source = this.expr();
      const key = this.expr();
      const namespace = this.expr();
      return `text(${source}, key=${key}, namespace=${namespace})`;
    }
    if (kind === 2 || kind === 3) return `text(${this.expr()})`;
    if (kind === 4) {
      this.pointer();
      const table = this.expr();
      const key = this.expr();
      return `text(table=${table}, key=${key})`;
    }
    if (kind === 0xff) return "text(none)";
    throw new KismetError(`unknown text kind ${kind}`, this.pos - 1);
  }

  switch() {
    const count = this.u16();
    this.u32();
    const index = this.expr();
    const cases = [];
    for (let i = 0; i < count; i += 1) {
      const value = this.expr();
      this.u32();
      cases.push(`${value}: ${this.expr()}`);
    }
    const fallback = this.expr();
    return `switch(${index}) {${cases.join("; ")}; default: ${fallback}}`;
  }

  numbers(count, read) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(this.number(read.call(this)));
    return out.join(", ");
  }

  // --- one expression
  expr() {
    const at = this.pos;
    const op = this.u8();
    switch (op) {
      case 0x00: case 0x48: return this.prop();
      case 0x01: return "self." + this.prop();
      case 0x02: return "default." + this.prop();
      case 0x6c: return "sparse." + this.prop();
      case 0x04: {
        const value = this.expr();
        return value === "nothing" ? "return" : `return ${value}`;
      }
      case 0x06: return `goto 0x${hex4(this.u32())}`;
      case 0x07: {
        const target = this.u32();
        return `if not (${this.expr()}) goto 0x${hex4(target)}`;
      }
      case 0x09:
        this.u16();
        this.u8();
        return `assert(${this.expr()})`;
      case 0x0b: return "nothing";
      case 0x0c: this.i32(); return "nothing";
      case 0x0f: {
        this.pointer();
        const target = this.expr();
        return `${target} = ${this.expr()}`;
      }
      case 0x14: case 0x43: case 0x44: case 0x5f: case 0x60: {
        const target = this.expr();
        return `${target} = ${this.expr()}`;
      }
      case 0x11: {
        const name = this.prop();
        return `bit(${name}, ${this.u8()})`;
      }
      case 0x12: case 0x19: case 0x1a: return this.context(op);
      case 0x13: case 0x2e: case 0x52: case 0x54: case 0x55: {
        const target = this.typeName();
        return `cast<${target}>(${this.expr()})`;
      }
      case 0x15: return "end_parm";
      case 0x17: return "self";
      case 0x18: this.u32(); return this.expr();
      case 0x1b: case 0x45: {
        const name = this.name();
        if (this.calledNames) this.calledNames.add(name);
        return this.call(name, this.args());
      }
      case 0x1c: case 0x46: case 0x68: {
        const name = this.function();
        return this.call(name, this.args());
      }
      case 0x1d: return String(this.i32());
      case 0x1e: return this.number(this.f32());
      case 0x1f: return quote(this.ansi());
      case 0x20: {
        const found = this.pointer();
        return found === null ? "null" : `object(${found})`;
      }
      case 0x21: return `name(${quote(this.name())})`;
      case 0x22: return `rotator(${this.numbers(3, this.f64)})`;
      case 0x23: return `vector(${this.numbers(3, this.f64)})`;
      case 0x41: return `vector(${this.numbers(3, this.f32)})`;
      case 0x24: case 0x2c: return String(this.u8());
      case 0x25: return "0";
      case 0x26: return "1";
      case 0x27: return "true";
      case 0x28: return "false";
      case 0x29: return this.textConst();
      case 0x2a: case 0x2d: return "null";
      case 0x2b: return `transform(${this.numbers(10, this.f64)})`;
      case 0x2f: {
        const name = this.typeName();
        this.i32();
        return `${name}{${this.until(0x30).join(", ")}}`;
      }
      case 0x31: {
        const target = this.expr();
        return `${target} = [${this.until(0x32).join(", ")}]`;
      }
      case 0x33: return `property(${this.prop()})`;
      case 0x34: return quote(this.utf16());
      case 0x35: return this.i64().toString();
      case 0x36: return this.u64().toString();
      case 0x37: return this.number(this.f64());
      case 0x38: {
        const kind = this.u8();
        return `${CAST_NAMES.get(kind) ?? "convert"}(${this.expr()})`;
      }
      case 0x39: {
        const target = this.expr();
        this.i32();
        return `${target} = set[${this.until(0x3a).join(", ")}]`;
      }
      case 0x3b: {
        const target = this.expr();
        this.i32();
        return `${target} = map[${this.until(0x3c).join(", ")}]`;
      }
      case 0x3d:
        this.pointer();
        this.i32();
        return `set[${this.until(0x3e).join(", ")}]`;
      case 0x3f:
        this.pointer();
        this.pointer();
        this.i32();
        return `map[${this.until(0x40).join(", ")}]`;
      case 0x42: {
        const name = this.prop();
        return `${this.expr()}.${name}`;
      }
      case 0x4b: return `delegate(${quote(this.name())})`;
      case 0x4c: return `push 0x${hex4(this.u32())}`;
      case 0x4d: return "pop";
      case 0x4e: return `goto (${this.expr()})`;
      case 0x4f: return `if not (${this.expr()}) pop`;
      case 0x50: case 0x5a: case 0x5e: return "nothing";
      case 0x51: return this.expr();
      case END_OF_SCRIPT: return "end";
      case 0x5b: return `0x${hex4(this.u32())}`;
      case 0x5c: {
        const target = this.expr();
        return `${target}.Add(${this.expr()})`;
      }
      case 0x5d: return `${this.expr()}.Clear()`;
      case 0x61: {
        const name = this.name();
        const target = this.expr();
        return `${target}.Bind(${this.expr()}, ${quote(name)})`;
      }
      case 0x62: {
        const target = this.expr();
        return `${target}.Remove(${this.expr()})`;
      }
      case 0x63: {
        this.pointer();
        const target = this.expr();
        return `${target}.Broadcast(${this.args().join(", ")})`;
      }
      case 0x64: {
        const name = this.prop();
        return `${name} = ${this.expr()}`;
      }
      case 0x65:
        this.pointer();
        this.i32();
        return `[${this.until(0x66).join(", ")}]`;
      case 0x67: return `soft(${this.expr()})`;
      case 0x69: return this.switch();
      case 0x6a:
        if (this.u8() === 4) this.name();
        return "nothing";
      case 0x6b: {
        const target = this.expr();
        return `${target}[${this.expr()}]`;
      }
      case 0x6d: return `field(${this.expr()})`;
      default:
        throw new KismetError(`unknown opcode 0x${op.toString(16).toUpperCase().padStart(2, "0")} at 0x${hex4(at)}`, at);
    }
  }
}

/**
 * Decodes one function's bytecode.
 *
 * Returns `{ statements, unresolved }`. Each statement is `{ offset, text, op }`, where `op` is
 * the EExprToken name of its top-level instruction; EX_Jump, EX_JumpIfNot and
 * EX_PushExecutionFlow also carry `target`, the offset they name. `unresolved` counts pointers
 * and names the lookups did not know. `refs` and `calledNames`, when given, are sets that
 * receive the paths the script refers to and the names of the functions it calls by name.
 *
 * `pointers` is a Map from BigInt address to path; `names` is a (sparse) array or a Map from
 * name index to text. Throws KismetError, whose `offset` locates the problem, for an unknown
 * opcode, a read past the end, or bytes that do not decode to exactly their length ending in
 * the end-of-script marker.
 */
export function disassemble(data, pointers, names, refs, calledNames) {
  const reader = new Disassembler(data, pointers, names, refs, calledNames);
  const statements = [];
  let ended = false;
  while (reader.pos < data.length) {
    const at = reader.pos;
    const text = reader.expr();
    if (text === "end") {
      ended = true;
      break;
    }
    if (text !== "nothing") {
      const opcode = data[at];
      const statement = { offset: at, text, op: OPCODE_NAMES.get(opcode) };
      if (JUMP_OPCODES.has(opcode)) statement.target = reader.view.getUint32(at + 1, true);
      statements.push(statement);
    }
  }
  if (!ended || reader.pos !== data.length) {
    throw new KismetError(`decoded ${reader.pos} of ${data.length} bytes, end marker ${ended ? "seen" : "missing"}`, reader.pos);
  }
  return { statements, unresolved: reader.unresolved };
}

// --- lookups

/**
 * Calls `onLine` for every line of a text file, read in chunks so that a file of hundreds of
 * megabytes is never held whole. Lines split at "\n", "\r\n" and "\r" as Python's universal
 * newlines do; the line ending is not passed. Invalid UTF-8 becomes U+FFFD.
 */
function eachLine(path, onLine) {
  const fd = openSync(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(1 << 20);
    let pending = "";
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      const eof = read === 0;
      pending += eof ? decoder.end() : decoder.write(buffer.subarray(0, read));
      let start = 0;
      for (let i = 0; i < pending.length; i += 1) {
        const c = pending.charCodeAt(i);
        if (c === 10) {
          onLine(pending.slice(start, i));
          start = i + 1;
        } else if (c === 13) {
          if (i + 1 === pending.length && !eof) break;
          onLine(pending.slice(start, i));
          if (pending.charCodeAt(i + 1) === 10) i += 1;
          start = i + 1;
        }
      }
      pending = pending.slice(start);
      if (eof) break;
    }
    if (pending) onLine(pending);
  } finally {
    closeSync(fd);
  }
}

/** Python's str.strip() for the whitespace that can occur in these files. */
function pyStrip(text) {
  return text.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, "");
}

/**
 * Address (BigInt) to path, from UE4SS_ObjectDump.txt. A line looks like
 * `[00007FF4431E2730] Function /Script/CoreUObject.Object:ExecuteUbergraph [n: 35B] ...`.
 * A later line for the same address replaces an earlier one.
 */
export function loadPointers(objectDumpPath) {
  const pointers = new Map();
  eachLine(objectDumpPath, (line) => {
    if (!line.startsWith("[")) return;
    const close = line.indexOf("]");
    const rest = close < 0 ? line.slice(1) : line.slice(close + 2);
    const space = rest.indexOf(" ");
    const tail = space < 0 ? "" : rest.slice(space + 1);
    const bracket = tail.indexOf(" [");
    const path = pyStrip(bracket < 0 ? tail : tail.slice(0, bracket));
    if (!path) return;
    const hex = pyStrip(close < 0 ? line.slice(1, -1) : line.slice(1, close)).replace(/^0[xX]/, "");
    if (!/^[0-9a-fA-F]+(_[0-9a-fA-F]+)*$/.test(hex)) return;
    pointers.set(BigInt("0x" + hex.replaceAll("_", "")), path);
  });
  return pointers;
}

function addNamesRecord(names, record) {
  if (typeof record === "string") record = JSON.parse(record);
  for (const [index, text] of Object.entries(record?.names ?? {})) {
    const key = Number.parseInt(index, 10);
    if (names[key] === undefined) names[key] = text;
  }
}

/**
 * Name index to text, as a sparse array, from fnames.csv (`index,number,name`; a quoted name
 * may hold commas). The first entry for an index wins. `namesLine` is the Names record of
 * Scripts/bytecode.jsonl (its JSON text or the parsed object, or an array of them); its names
 * fill indexes the CSV does not have. `fnamesCsvPath` may be null when the run has no CSV.
 */
export function loadNames(fnamesCsvPath, namesLine) {
  const names = [];
  if (fnamesCsvPath) {
    let first = true;
    eachLine(fnamesCsvPath, (line) => {
      if (first) {
        first = false;
        return;
      }
      const comma = line.indexOf(",");
      const index = comma < 0 ? line : line.slice(0, comma);
      const rest = comma < 0 ? "" : line.slice(comma + 1);
      const second = rest.indexOf(",");
      let text = second < 0 ? "" : rest.slice(second + 1);
      if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).replaceAll('""', '"');
      if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(index)) return;
      const key = Number(index.trim().replaceAll("_", ""));
      if (names[key] === undefined) names[key] = text;
    });
  }
  if (namesLine !== undefined && namesLine !== null) {
    for (const record of Array.isArray(namesLine) ? namesLine : [namesLine]) addNamesRecord(names, record);
  }
  return names;
}
