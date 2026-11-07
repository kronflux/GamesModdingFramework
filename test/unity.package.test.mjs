import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import "../src/engines/unity/index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-unity-package-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function project(name, { manifest, version = "1.2.3", config = {} } = {}) {
  const workspace = { root: path.join(root, name, "ws"), config: { version: 1, ...config }, local: { version: 1 }, profile: null };
  const modDir = path.join(workspace.root, "mods", name);
  fs.mkdirSync(path.join(modDir, "bin", "Release"), { recursive: true });
  fs.writeFileSync(path.join(modDir, "bin", "Release", `${name}.dll`), "SYNTHETIC ASSEMBLY");
  fs.writeFileSync(path.join(modDir, `${name}.csproj`), `<Project><PropertyGroup><Version>${version}</Version></PropertyGroup></Project>`);
  if (manifest !== undefined) fs.writeFileSync(path.join(modDir, "manifest.json"), manifest);
  return { workspace, modDir };
}

// Reads the general purpose flags of every local header (offset 6) and every
// central directory header (offset 8).
function zipFlags(buffer) {
  const flags = { local: [], central: [] };
  for (let at = 0; at + 4 <= buffer.length; at += 1) {
    const signature = buffer.readUInt32LE(at);
    if (signature === 0x04034b50) flags.local.push(buffer.readUInt16LE(at + 6));
    if (signature === 0x02014b50) flags.central.push(buffer.readUInt16LE(at + 8));
  }
  return flags;
}

test("every zip entry carries the UTF-8 name flag in both headers", async () => {
  const { workspace, modDir } = project("FlagMod");
  const result = await executeOperation("unity.package", { modDir }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  const flags = zipFlags(fs.readFileSync(result.data.zip));
  assert.equal(flags.local.length, result.data.entries.length);
  assert.equal(flags.central.length, result.data.entries.length);
  for (const flag of [...flags.local, ...flags.central]) assert.equal(flag & 0x0800, 0x0800);
});

test("a manifest that is not JSON fails with the file named", async () => {
  const { workspace, modDir } = project("BadManifestMod", { manifest: "{ not json" });
  const result = await executeOperation("unity.package", { modDir }, { workspace });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-EXEC-001");
  assert.match(result.error.message, /manifest\.json/);
});

test("a manifest without version_number takes the project version", async () => {
  const { workspace, modDir } = project("NoVersionMod", { manifest: JSON.stringify({ name: "NoVersionMod" }), version: "2.0.1" });
  const result = await executeOperation("unity.package", { modDir }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(path.basename(result.data.zip), "NoVersionMod-2.0.1.zip");
  assert.equal(result.data.manifest.version_number, "2.0.1");
});

test("a team or manifest name with a path separator is refused", async () => {
  const team = project("SeparatorTeamMod", { config: { package: { team: "a/b" } } });
  const refusedTeam = await executeOperation("unity.package", { modDir: team.modDir }, { workspace: team.workspace });
  assert.equal(refusedTeam.ok, false);
  assert.equal(refusedTeam.error.code, "GMF-E-EXEC-001");
  assert.equal(fs.existsSync(path.join(team.workspace.root, "package")), false);

  const named = project("SeparatorNameMod", { manifest: JSON.stringify({ name: "x\\y", version_number: "1.0.0" }) });
  const refusedName = await executeOperation("unity.package", { modDir: named.modDir }, { workspace: named.workspace });
  assert.equal(refusedName.ok, false);
  assert.equal(refusedName.error.code, "GMF-E-EXEC-001");
});
