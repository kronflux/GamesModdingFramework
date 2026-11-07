import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readVersionStrings, parseUeBuildVersion } from "../src/engines/unreal/sig/pe.mjs";
import { detectUeVersion } from "../src/engines/unreal/detect.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// Build one VS_VERSIONINFO String structure: wLength, wValueLength, wType,
// UTF-16 key with terminator, padding to 32 bits, UTF-16 value with terminator.
function stringEntry(key, value) {
  const keyBytes = Buffer.from(`${key}\0`, "utf16le");
  const valueBytes = Buffer.from(`${value}\0`, "utf16le");
  const headerAndKey = 6 + keyBytes.length;
  const pad = (4 - (headerAndKey % 4)) % 4;
  const total = headerAndKey + pad + valueBytes.length;
  const out = Buffer.alloc(total);
  out.writeUInt16LE(total, 0);
  out.writeUInt16LE(value.length + 1, 2);
  out.writeUInt16LE(1, 4);
  keyBytes.copy(out, 6);
  valueBytes.copy(out, headerAndKey + pad);
  return out;
}

function fakeExe() {
  // Not a valid PE: the reader falls back to scanning the whole buffer.
  return Buffer.concat([
    Buffer.from("MZ synthetic header padding."),
    Buffer.alloc(3),
    stringEntry("ProductName", "Fixture Game"),
    stringEntry("ProductVersion", "++UE5+Release-5.6-CL-44394996"),
    stringEntry("FileVersion", "++UE5+Release-5.6-CL-44394996"),
  ]);
}

test("readVersionStrings reads ProductName and ProductVersion from version resource strings", () => {
  const strings = readVersionStrings(fakeExe());
  assert.equal(strings.ProductName, "Fixture Game");
  assert.equal(strings.ProductVersion, "++UE5+Release-5.6-CL-44394996");
});

test("parseUeBuildVersion reads the engine version and changelist from an Unreal build string", () => {
  assert.deepEqual(parseUeBuildVersion("++UE5+Release-5.6-CL-44394996"), { version: "5.6", changelist: "44394996", branch: "++UE5+Release-5.6" });
  assert.deepEqual(parseUeBuildVersion("++UE4+Release-4.27-CL-18319896"), { version: "4.27", changelist: "18319896", branch: "++UE4+Release-4.27" });
  assert.equal(parseUeBuildVersion("1.0.0.0"), null);
});

test("detectUeVersion falls back to the shipping executable version resource", (t) => {
  const dir = tempDir(t, "gmf-uever-");
  const exe = path.join(dir, "Fixture-Win64-Shipping.exe");
  fs.writeFileSync(exe, fakeExe());
  const result = detectUeVersion(dir, exe);
  assert.equal(result.version, "5.6");
  assert.equal(result.confidence, "observed");
  assert.match(result.evidence[0].claim, /5\.6/);
  assert.equal(result.evidence[0].detail.changelist, "44394996");
});
