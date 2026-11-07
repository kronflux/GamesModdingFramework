// Signature output: UE4SS Lua signature modules and the byte-pattern emitter.

import { compilePattern, findInRange, parsePe } from "./pe.mjs";
import { decodeLength } from "./disasm.mjs";

function commentLine(comment) {
  return comment ? `-- ${comment}\n` : "";
}

const hex = (value) => `0x${value.toString(16)}`;

// UE4SS export signature (exact mangled name).
export function emitExport(mangled, comment = "") {
  return `${commentLine(comment)}return LoadExport("${mangled}")\n`;
}

// UE4SS AOB signature module.
export function emitAob(aob, comment = "") {
  return (
    commentLine(comment) +
    "function Register()\n" +
    `    return "${aob}"\n` +
    "end\n" +
    "\n" +
    "function OnMatchFound(MatchAddress)\n" +
    "    return MatchAddress\n" +
    "end\n"
  );
}

// UE4SS indirect signature: resolve a rel32 jump or call at jmpOffset. Offsets render as hex.
export function emitIndirect(aob, jmpOffset, instrSize, comment = "") {
  return (
    commentLine(comment) +
    "function Register()\n" +
    `    return "${aob}"\n` +
    "end\n" +
    "\n" +
    "function OnMatchFound(MatchAddress)\n" +
    `    local InstrSize = ${hex(instrSize)}\n` +
    `    local JmpInstr = MatchAddress + ${hex(jmpOffset)}\n` +
    "    local Offset = DerefToInt32(JmpInstr + 0x1)\n" +
    "    local Destination = JmpInstr + Offset + InstrSize\n" +
    "    return Destination\n" +
    "end\n"
  );
}

// A parsed PE with at least one section, or null for any other input (then offsets are plain buffer offsets).
function tryParsePe(buffer) {
  try {
    const pe = parsePe(buffer);
    return pe.sections.length > 0 ? pe : null;
  } catch {
    return null;
  }
}

// Match offsets are file offsets. For a PE the scan covers the raw ranges of its sections only.
export function findPattern(buffer, pattern) {
  const compiled = compilePattern(pattern);
  const pe = tryParsePe(buffer);
  if (!pe || pe.sections.length === 0) return findInRange(buffer, compiled, 0, buffer.length);
  const hits = [];
  for (const sec of pe.sections) {
    if (sec.rawSize === 0) continue;
    const stop = Math.min(sec.rawOffset + sec.rawSize, buffer.length);
    if (sec.rawOffset < stop) findInRange(buffer, compiled, sec.rawOffset, stop, hits);
  }
  return hits.sort((a, b) => a - b);
}

// Build a wildcarded pattern from whole instructions starting at a file offset. RIP-relative displacements
// and rel32 operands become wildcards. Stops at maxBytes, at a ret, or at the end of the buffer, and at an
// instruction the length decoder does not know (the pattern so far is kept).
export function emitSignature(buffer, offset, { maxBytes = 32 } = {}) {
  const pe = tryParsePe(buffer);
  const tokens = [];
  let mask = "";
  let target = null;
  let pos = offset;
  while (pos < buffer.length) {
    let insn;
    try {
      insn = decodeLength(buffer, pos, pe);
    } catch (error) {
      if (tokens.length === 0) throw error;
      break;
    }
    if (tokens.length + insn.length > maxBytes) break;
    for (let i = 0; i < insn.length; i += 1) {
      const wild = insn.ripDispOffset !== null && i >= insn.ripDispOffset && i < insn.ripDispOffset + 4;
      tokens.push(wild ? "??" : buffer[pos + i].toString(16).toUpperCase().padStart(2, "0"));
      mask += wild ? "?" : "x";
    }
    if (target === null && insn.ripRelative) target = insn.ripRelative.targetOffset;
    pos += insn.length;
    if (insn.ret) break;
  }
  if (tokens.length === 0) throw new Error(`no instruction fits in maxBytes=${maxBytes} at offset 0x${offset.toString(16)}`);
  const pattern = tokens.join(" ");
  return { pattern, mask, matches: findPattern(buffer, pattern), target };
}
