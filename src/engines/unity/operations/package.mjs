import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { assertInside } from "../../../core/workspace.mjs";
import { findBuiltAssembly } from "./deploy.mjs";
import { modDirFor } from "./defaults.mjs";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// General purpose bit 11: entry names are UTF-8.
const UTF8_NAME_FLAG = 0x0800;

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAME_FLAG, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAME_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

// The <Version> of the mod's project file, or 0.1.0.
function projectVersion(modDir, name) {
  const csproj = path.join(modDir, `${name}.csproj`);
  try {
    const match = fs.readFileSync(csproj, "utf8").match(/<Version>\s*([0-9]+\.[0-9]+\.[0-9]+)\s*<\/Version>/);
    if (match) return match[1];
  } catch {
    // No project file: fall back to the default version.
  }
  return "0.1.0";
}

function manifestFor(name, version) {
  return {
    name,
    version_number: version,
    website_url: "",
    description: `A ${name} mod scaffolded by GMF.`,
    dependencies: [],
  };
}

const operation = {
  id: "unity.package",
  title: "Package a Unity mod",
  summary: "Build a local Thunderstore-style zip with the mod assembly, manifest and README.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      modDir: { type: "string" },
      out: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      zip: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "unity-bepinex",
  docs: [],
  handler: async (inputs, context) => {
    if (!context.workspace?.root) {
      const error = new Error("unity.package needs a workspace");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run gmf init first.";
      throw error;
    }
    const modDir = modDirFor(inputs, context);
    if (!modDir) {
      const error = new Error("unity.package needs a mod project folder");
      error.code = "GMF-E-EXEC-001";
      error.remediation =
        "Pass --input modDir=<dir>, or scaffold exactly one mod so the workspace mods folder has one project.";
      throw error;
    }
    if (!fs.existsSync(modDir) || !fs.statSync(modDir).isDirectory()) {
      const error = new Error(`Mod project folder does not exist: ${modDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run unity.scaffold first or pass the mod project folder.";
      throw error;
    }

    const name = path.basename(modDir);
    const built = findBuiltAssembly(modDir, name);
    if (!built) {
      const error = new Error(`No built assembly was found under ${path.join(modDir, "bin")}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run unity.build before packaging.";
      throw error;
    }

    // Thunderstore and mod managers name a package Team-Name-Version; the team
    // comes from gmf.json "package": { "team": "..." }.
    const manifestPath = path.join(modDir, "manifest.json");
    let manifest;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (cause) {
        const error = new Error(`GMF-E-EXEC-001: ${manifestPath} is not valid JSON: ${cause.message}`);
        error.code = "GMF-E-EXEC-001";
        error.remediation = "Fix or delete manifest.json; unity.package writes a default one when it is absent.";
        throw error;
      }
    } else {
      manifest = manifestFor(name, projectVersion(modDir, name));
    }
    const version = manifest.version_number || projectVersion(modDir, name);
    manifest = { ...manifest, version_number: version };
    const team = String(context.workspace.config?.package?.team || "").trim();
    const packageName = String(manifest.name || name);
    for (const [label, value] of [["team", team], ["name", packageName], ["version", String(version)]]) {
      if (/[\\/]/.test(value)) {
        const error = new Error(`GMF-E-EXEC-001: the package ${label} must not contain a path separator: ${value}`);
        error.code = "GMF-E-EXEC-001";
        error.remediation = `Change the ${label} in gmf.json package settings or manifest.json.`;
        throw error;
      }
    }
    const zipName = `${team ? `${team}-` : ""}${packageName}-${version}.zip`;
    const out = assertInside(context.workspace, inputs.out || path.join(context.workspace.root, "package", zipName));

    const entries = [
      { name: `BepInEx/plugins/${name}/${name}.dll`, data: fs.readFileSync(built) },
    ];
    entries.push({
      name: "manifest.json",
      data: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    const readmePath = path.join(modDir, "README.md");
    if (fs.existsSync(readmePath)) {
      entries.push({ name: "README.md", data: fs.readFileSync(readmePath) });
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zipBuffer(entries));

    return {
      data: { zip: out, manifest, entries: entries.map((entry) => entry.name) },
      evidence: [
        evidence({
          claim: `Packaged ${name} into ${out}`,
          confidence: "observed",
          authority: "controlled-replay",
          source: out,
          detail: { entries: entries.length },
        }),
      ],
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
