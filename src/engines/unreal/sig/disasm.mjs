// x86-64 instruction length decoder for the signature emitter.
// It is dependency-free and only answers "how long is the instruction at this offset, and does it carry a RIP-relative displacement".
// It handles the integer, SSE move and control-flow subset that compilers emit in function prologues.

import { fileOffsetToRva, rvaToFileOffset } from "./pe.mjs";

const PREFIXES = new Set([0x66, 0x67, 0xf0, 0xf2, 0xf3, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65]);

// One-byte opcodes: modrm only, modrm + imm8, modrm + imm32 (imm16 with 0x66), no operands, imm8 only, imm32 only.
const MODRM = new Set([0x63, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8d, 0x8f, 0xfe, 0xff, 0xd0, 0xd1, 0xd2, 0xd3]);
const MODRM_IMM8 = new Set([0x80, 0x83, 0xc0, 0xc1, 0xc6, 0x6b]);
const MODRM_IMM32 = new Set([0x81, 0xc7, 0x69]);
const NO_OPERAND = new Set([0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9c, 0x9d, 0xa4, 0xa5, 0xaa, 0xab, 0xc3, 0xc9, 0xcc, 0xf4, 0xfc, 0xfd]);
const IMM8 = new Set([0xa8, 0x6a, 0xeb, 0xcd]);

// Two-byte (0x0F xx) opcodes.
const TWO_MODRM = new Set([
  0x0d, 0x18, 0x1f, 0x51, 0x54, 0x57, 0x58, 0x59, 0x5a, 0x5c, 0x5e, 0x6e, 0x6f, 0x7e, 0x7f,
  0xa3, 0xab, 0xaf, 0xb0, 0xb1, 0xb6, 0xb7, 0xbe, 0xbf, 0xc1, 0xd6, 0xeb, 0xef, 0xdb,
]);
const TWO_MODRM_IMM8 = new Set([0xba, 0x70, 0xc6]);
const TWO_NO_OPERAND = new Set([0x05, 0xa2]);

function i32(bytes, at) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(at, true);
}

function decodeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// File offset of a RIP-relative target. Without a parsed image the buffer is flat and the target is plain
// arithmetic. With one, the displacement applies to RVAs: the instruction's file offset is mapped to its RVA,
// the target RVA is mapped back, and null means the target is outside every section's raw data.
function ripTarget(pe, offset, length, disp) {
  if (!pe) return offset + length + disp;
  const rva = fileOffsetToRva(pe, offset);
  if (rva === null) return null;
  return rvaToFileOffset(pe, rva + length + disp);
}

// pe is optional: pass a parsed image to resolve RIP-relative targets across sections.
export function decodeLength(bytes, offset = 0, pe = null) {
  let pos = offset;
  const need = (count) => {
    if (pos + count > bytes.length) throw decodeError("GMF-E-SIG-002", `truncated instruction at offset 0x${offset.toString(16)}`);
  };
  const unsupported = (op) =>
    decodeError("GMF-E-SIG-002", `unsupported opcode ${op.map((b) => b.toString(16).padStart(2, "0")).join(" ")} at offset 0x${offset.toString(16)}`);

  let opsize16 = false;
  for (;;) {
    need(1);
    if (!PREFIXES.has(bytes[pos])) break;
    if (bytes[pos] === 0x66) opsize16 = true;
    pos += 1;
  }
  need(1);
  let rexW = false;
  if ((bytes[pos] & 0xf0) === 0x40) {
    rexW = (bytes[pos] & 0x08) !== 0;
    pos += 1;
  }
  need(1);
  const op = bytes[pos];
  pos += 1;

  let rip = null; // {disp, dispAt} with dispAt absolute in bytes
  const immBytes = (count) => {
    need(count);
    pos += count;
  };
  const imm32 = () => immBytes(opsize16 && !rexW ? 2 : 4);
  const modrm = () => {
    need(1);
    const byte = bytes[pos];
    pos += 1;
    const mod = byte >> 6;
    const rm = byte & 7;
    if (mod === 3) return byte;
    if (rm === 4) {
      need(1);
      const sib = bytes[pos];
      pos += 1;
      if (mod === 0 && (sib & 7) === 5) immBytes(4);
    }
    if (mod === 0 && rm === 5) {
      need(4);
      rip = { dispAt: pos, disp: i32(bytes, pos) };
      pos += 4;
    } else if (mod === 1) {
      immBytes(1);
    } else if (mod === 2) {
      immBytes(4);
    }
    return byte;
  };

  if (op === 0x0f) {
    need(1);
    const op2 = bytes[pos];
    pos += 1;
    if (op2 >= 0x80 && op2 <= 0x8f) {
      need(4);
      rip = { dispAt: pos, disp: i32(bytes, pos) };
      pos += 4;
    } else if (TWO_NO_OPERAND.has(op2) || (op2 >= 0xc8 && op2 <= 0xcf)) {
      // length already consumed
    } else if (op2 >= 0x10 && op2 <= 0x17) {
      modrm();
    } else if (op2 >= 0x28 && op2 <= 0x2f) {
      modrm();
    } else if ((op2 >= 0x40 && op2 <= 0x4f) || (op2 >= 0x90 && op2 <= 0x9f) || TWO_MODRM.has(op2)) {
      modrm();
    } else if (TWO_MODRM_IMM8.has(op2)) {
      modrm();
      immBytes(1);
    } else {
      throw unsupported([op, op2]);
    }
  } else if (op < 0x40 && (op & 7) < 4) {
    modrm();
  } else if (op < 0x40 && (op & 7) === 4) {
    immBytes(1);
  } else if (op < 0x40 && (op & 7) === 5) {
    imm32();
  } else if (op >= 0x50 && op <= 0x5f) {
    // push/pop register
  } else if (MODRM.has(op)) {
    modrm();
  } else if (MODRM_IMM8.has(op)) {
    modrm();
    immBytes(1);
  } else if (MODRM_IMM32.has(op)) {
    modrm();
    imm32();
  } else if (op === 0xf6 || op === 0xf7) {
    const byte = modrm();
    const reg = (byte >> 3) & 7;
    if (reg < 2) {
      if (op === 0xf6) immBytes(1);
      else imm32();
    }
  } else if (NO_OPERAND.has(op)) {
    // single byte
  } else if (IMM8.has(op) || (op >= 0x70 && op <= 0x7f) || (op >= 0xb0 && op <= 0xb7)) {
    immBytes(1);
  } else if (op >= 0xb8 && op <= 0xbf) {
    if (rexW) immBytes(8);
    else imm32();
  } else if (op === 0xa9 || op === 0x68) {
    imm32();
  } else if (op === 0xc2) {
    immBytes(2);
  } else if (op === 0xe8 || op === 0xe9) {
    need(4);
    rip = { dispAt: pos, disp: i32(bytes, pos) };
    pos += 4;
  } else {
    throw unsupported([op]);
  }

  const length = pos - offset;
  return {
    length,
    // True for ret and ret imm16 (an F3 prefix is part of the instruction).
    ret: op === 0xc3 || op === 0xc2,
    ripRelative: rip ? { disp: rip.disp, targetOffset: ripTarget(pe, offset, length, rip.disp) } : null,
    // Where the 4 displacement bytes sit inside the instruction, for wildcarding. Null without RIP-relative operand.
    ripDispOffset: rip ? rip.dispAt - offset : null,
  };
}

// Decode the instruction at an RVA of a parsed image.
export function decodeAtRva(pe, buffer, rva) {
  const offset = rvaToFileOffset(pe, rva);
  if (offset === null) throw new Error(`rva 0x${rva.toString(16).toUpperCase()} is not mapped to a file offset`);
  return decodeLength(buffer, offset, pe);
}
