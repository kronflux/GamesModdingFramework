// Builds minimal synthetic PE32+ images in memory. No real game bytes: the code is a handful of instructions.
// Builders for minimal synthetic PE32+ images, with an import table and a code-only image.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IMAGE_BASE = 0x140000000;
export const MACHINE_AMD64 = 0x8664;
export const MAGIC_PE32PLUS = 0x20b;
export const MAGIC_PE32 = 0x10b;
export const MEM_EXECUTE = 0x20000000;
export const MEM_READ = 0x40000000;
export const E_LFANEW = 0x80;
export const OPT_OFF = E_LFANEW + 4 + 20;
export const SIZE_OF_OPTIONAL_HEADER = 240;
export const SEC_TABLE_OFF = OPT_OFF + SIZE_OF_OPTIONAL_HEADER;
export const RAW_OFF = 0x200;
export const VADDR = 0x1000;
export const TIMESTAMP = 0x65000000;

// mov [rsp+8], rbx ; nop ; nop ; nop
export const CODE = Buffer.from([0x48, 0x89, 0x5c, 0x24, 0x08, 0x90, 0x90, 0x90]);

function sectionContent() {
  // Offsets inside the section; RVA is VADDR + offset.
  const buf = Buffer.alloc(0x100);
  CODE.copy(buf, 0);
  const ed = 0x40;
  const eat = 0x68;
  const ent = 0x6c;
  const eno = 0x70;
  const modname = 0x74;
  const expname = 0x84;
  buf.writeUInt32LE(VADDR + modname, ed + 12);
  buf.writeUInt32LE(1, ed + 16);
  buf.writeUInt32LE(1, ed + 20);
  buf.writeUInt32LE(1, ed + 24);
  buf.writeUInt32LE(VADDR + eat, ed + 28);
  buf.writeUInt32LE(VADDR + ent, ed + 32);
  buf.writeUInt32LE(VADDR + eno, ed + 36);
  buf.writeUInt32LE(VADDR + 0, eat);
  buf.writeUInt32LE(VADDR + expname, ent);
  buf.writeUInt16LE(0, eno);
  buf.write("fixture.dll", modname, "latin1");
  buf.write("TestExport", expname, "latin1");

  // Import directory: one descriptor plus a zero terminator, one thunk, one hint/name entry.
  const imp = 0x90;
  const thunks = 0xb8;
  const hintName = 0xd0;
  const dllName = 0xe0;
  buf.writeUInt32LE(VADDR + thunks, imp + 0);
  buf.writeUInt32LE(VADDR + dllName, imp + 12);
  buf.writeUInt32LE(VADDR + thunks, imp + 16);
  buf.writeBigUInt64LE(BigInt(VADDR + hintName), thunks);
  buf.write("ExitProcess", hintName + 2, "latin1");
  buf.write("KERNEL32.dll", dllName, "latin1");
  return { content: buf, exportRva: VADDR + 0, exportDirRva: VADDR + ed, importDirRva: VADDR + imp };
}

function writeHeaders(img, sectionCount) {
  img.writeUInt16LE(0x5a4d, 0);
  img.writeUInt32LE(E_LFANEW, 0x3c);
  img.writeUInt32LE(0x00004550, E_LFANEW);
  const coff = E_LFANEW + 4;
  img.writeUInt16LE(MACHINE_AMD64, coff);
  img.writeUInt16LE(sectionCount, coff + 2);
  img.writeUInt32LE(TIMESTAMP, coff + 4);
  img.writeUInt16LE(SIZE_OF_OPTIONAL_HEADER, coff + 16);
  img.writeUInt16LE(0x22, coff + 18);
  img.writeUInt16LE(MAGIC_PE32PLUS, OPT_OFF);
  img.writeUInt32LE(VADDR, OPT_OFF + 16);
  img.writeUInt32LE(VADDR, OPT_OFF + 20);
  img.writeBigUInt64LE(BigInt(IMAGE_BASE), OPT_OFF + 24);
  img.writeUInt32LE(0x1000, OPT_OFF + 32);
  img.writeUInt32LE(0x200, OPT_OFF + 36);
  img.writeUInt32LE(16, OPT_OFF + 108);
}

function writeSection(img, index, { name, vaddr, rawOff, size, flags }) {
  const sh = SEC_TABLE_OFF + index * 40;
  img.write(name, sh, "latin1");
  img.writeUInt32LE(size, sh + 8);
  img.writeUInt32LE(vaddr, sh + 12);
  img.writeUInt32LE(size, sh + 16);
  img.writeUInt32LE(rawOff, sh + 20);
  img.writeUInt32LE(flags, sh + 36);
}

// One .text section holding CODE, an export table and an import table.
export function buildPe32Plus() {
  const { content, exportRva, exportDirRva, importDirRva } = sectionContent();
  const img = Buffer.alloc(RAW_OFF + content.length);
  writeHeaders(img, 1);
  img.writeUInt32LE(exportDirRva, OPT_OFF + 112);
  img.writeUInt32LE(0x100, OPT_OFF + 112 + 4);
  img.writeUInt32LE(importDirRva, OPT_OFF + 112 + 8);
  img.writeUInt32LE(0x28, OPT_OFF + 112 + 12);
  writeSection(img, 0, { name: ".text", vaddr: VADDR, rawOff: RAW_OFF, size: content.length, flags: MEM_EXECUTE | MEM_READ });
  content.copy(img, RAW_OFF);
  return {
    image: img,
    meta: { exportName: "TestExport", exportRva, codeRva: VADDR, rawSize: content.length, importDll: "KERNEL32.dll", importName: "ExitProcess" },
  };
}

// A PE with one .text section whose bytes are exactly `code` (no export or import tables).
export function buildCodePe(code) {
  const content = Buffer.from(code);
  const img = Buffer.alloc(RAW_OFF + content.length);
  writeHeaders(img, 1);
  writeSection(img, 0, { name: ".text", vaddr: VADDR, rawOff: RAW_OFF, size: content.length, flags: MEM_EXECUTE | MEM_READ });
  content.copy(img, RAW_OFF);
  return img;
}

export function buildPeTwoExec() {
  const size = 0x80;
  const img = Buffer.alloc(RAW_OFF + size * 2);
  writeHeaders(img, 2);
  writeSection(img, 0, { name: ".text", vaddr: 0x1000, rawOff: RAW_OFF, size, flags: MEM_EXECUTE | MEM_READ });
  writeSection(img, 1, { name: ".text1", vaddr: 0x2000, rawOff: RAW_OFF + size, size, flags: MEM_EXECUTE | MEM_READ });
  return img;
}

// MZ, e_lfanew = 0x40, "PE\0\0" at 0x40, cut off right after the signature.
export function buildTruncatedAfterPeSig() {
  const img = Buffer.alloc(0x44);
  img.writeUInt16LE(0x5a4d, 0);
  img.writeUInt32LE(0x40, 0x3c);
  img.writeUInt32LE(0x00004550, 0x40);
  return img;
}

// Writes into a fresh temp directory and returns {path, dir}. Callers remove `dir` when done.
export function writeTemp(data, name = "fixture.exe") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-sig-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return { path: file, dir };
}
