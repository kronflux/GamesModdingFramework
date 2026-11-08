// AES-encrypted Unreal containers: detection from the pak footer and the
// IoStore header, key sources and normalization, and the --aes-key arguments
// passed to repak and retoc. No real encrypted game is involved; the headers
// are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { aesArgs, detectEncryption, normalizeAesKey, pakIndexEncrypted, resolveAesKey, utocEncrypted } from "../src/engines/unreal/operations/encryption.mjs";
import { tempDir } from "./helpers/tmp.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const HEX_KEY = "0x" + "ab".repeat(32);
const BASE64_KEY = Buffer.from("ab".repeat(32), "hex").toString("base64");

// A pak footer: 16-byte key guid, bEncryptedIndex, magic, then version and index fields.
function pakFile(dir, name, encrypted) {
  const body = Buffer.from("SYNTHETIC PAK BODY");
  const footer = Buffer.concat([
    Buffer.alloc(16),
    Buffer.from([encrypted ? 1 : 0]),
    Buffer.from([0xe1, 0x12, 0x6f, 0x5a]),
    Buffer.from([11, 0, 0, 0]),
    Buffer.alloc(8 + 8 + 20),
  ]);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([body, footer]));
  return file;
}

// An IoStore table of contents header with ContainerFlags at byte 80 (after the
// 16-byte magic, version and reserved bytes, nine u32 fields, the container id
// and the 16-byte encryption key guid).
function utocFile(dir, name, flags) {
  const head = Buffer.alloc(144);
  head.write("-==--==--==--==-", 0, "latin1");
  head[16] = 3;
  head[80] = flags;
  const file = path.join(dir, name);
  fs.writeFileSync(file, head);
  return file;
}

test("normalizeAesKey accepts hex with or without 0x and 44-character base64, and refuses anything else", () => {
  assert.equal(normalizeAesKey(HEX_KEY), HEX_KEY);
  assert.equal(normalizeAesKey(HEX_KEY.slice(2).toUpperCase()), HEX_KEY);
  assert.equal(normalizeAesKey(BASE64_KEY), HEX_KEY);
  assert.equal(normalizeAesKey(""), null);
  assert.throws(() => normalizeAesKey("0x1234"), (error) => error.code === "GMF-E-PLAN-001");
  assert.throws(() => normalizeAesKey("not a key at all"), (error) => error.code === "GMF-E-PLAN-001");
});

test("the key comes from the input, then the environment, then gmf.local.json, and the value is never in the source label", () => {
  const workspace = { root: "x", local: { version: 1, aesKey: BASE64_KEY } };
  assert.deepEqual(resolveAesKey({ aesKey: HEX_KEY }, { workspace }, { GMF_AES_KEY: "0x" + "cd".repeat(32) }), { key: HEX_KEY, source: "input" });
  assert.deepEqual(resolveAesKey({}, { workspace }, { GMF_AES_KEY: "0x" + "cd".repeat(32) }), { key: "0x" + "cd".repeat(32), source: "environment" });
  assert.deepEqual(resolveAesKey({}, { workspace }, {}), { key: HEX_KEY, source: "gmf.local.json" });
  assert.equal(resolveAesKey({}, { workspace: { root: "x", local: {} } }, {}), null);
  assert.deepEqual(aesArgs({ key: HEX_KEY, source: "input" }), ["--aes-key", HEX_KEY]);
  assert.deepEqual(aesArgs(null), []);
});

test("encryption is read from the pak footer and the IoStore header", (t) => {
  const dir = tempDir(t, "gmf-aes-");
  assert.equal(pakIndexEncrypted(pakFile(dir, "plain.pak", false)), false);
  assert.equal(pakIndexEncrypted(pakFile(dir, "secret.pak", true)), true);
  assert.equal(utocEncrypted(utocFile(dir, "plain.utoc", 0x09)), false, "compressed and indexed, not encrypted");
  assert.equal(utocEncrypted(utocFile(dir, "secret.utoc", 0x0b)), true);
  fs.writeFileSync(path.join(dir, "odd.utoc"), "SYNTHETIC UTOC");
  assert.equal(utocEncrypted(path.join(dir, "odd.utoc")), null, "an unreadable header is unknown, not a verdict");
  const detection = detectEncryption(dir);
  assert.equal(detection.encrypted, true);
  assert.deepEqual(detection.containers, ["secret.pak", "secret.utoc"]);
  assert.deepEqual(detection.unknown, ["odd.utoc"]);
});

test("unreal.extract_assets refuses an encrypted game without a key and passes --aes-key before the subcommand with one", async (t) => {
  const dir = tempDir(t, "gmf-aes-game-");
  const game = path.join(dir, "Game");
  const paks = path.join(game, "Content", "Paks");
  fs.mkdirSync(paks, { recursive: true });
  pakFile(paks, "Game-Windows.pak", true);
  const workspace = { root: path.join(dir, "ws"), config: { version: 1 }, local: { version: 1 }, profile: { engine: { id: "unreal", version: "5.4" } } };
  fs.mkdirSync(workspace.root, { recursive: true });
  const cacheDir = path.join(dir, "tools");
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(cacheDir, "tools.json"), JSON.stringify({ repak: { id: "repak", version: "fake", path: process.execPath, args: ["--repak"], verification: { kind: "none", ok: true } } }));
  const calls = [];
  const runProcess = async (cmd, argv) => {
    calls.push(argv.slice(1));
    if (argv[1] === "--aes-key" && argv[3] === "list") return { code: 0, stdout: "Game/Content/Data/DT_Tips.uasset\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const context = { workspace, toolCacheDir: cacheDir, runProcess, env: {} };

  const refused = await executeOperation("unreal.extract_assets", { gameDir: game, filter: "DT_Tips" }, context);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-GAME-002");
  assert.match(refused.error.message, /Game-Windows\.pak/);
  assert.deepEqual(calls, [], "no tool ran");
  assert.equal(fs.existsSync(path.join(workspace.root, "extracted")), false, "nothing was written");

  const result = await executeOperation("unreal.extract_assets", { gameDir: game, filter: "DT_Tips", aesKey: BASE64_KEY }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(calls[0].slice(0, 4), ["--aes-key", HEX_KEY, "list", path.join(paks, "Game-Windows.pak")]);
  assert.deepEqual(calls[1].slice(0, 3), ["--aes-key", HEX_KEY, "unpack"]);
  assert.equal(result.data.encrypted, true);
  assert.equal(result.data.aesKeySource, "input");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(HEX_KEY.slice(2)) && !serialized.includes(BASE64_KEY), "the key never appears in the result");
});

test("an IoStore game with the key in gmf.local.json runs retoc with --aes-key first", async (t) => {
  const dir = tempDir(t, "gmf-aes-io-");
  const game = path.join(dir, "Game");
  const paks = path.join(game, "Content", "Paks");
  fs.mkdirSync(paks, { recursive: true });
  utocFile(paks, "Game-Windows.utoc", 0x0b);
  fs.writeFileSync(path.join(paks, "Game-Windows.ucas"), "SYNTHETIC UCAS");
  pakFile(paks, "Game-Windows.pak", false);
  const workspace = { root: path.join(dir, "ws"), config: { version: 1 }, local: { version: 1, aesKey: HEX_KEY }, profile: { engine: { id: "unreal", version: "5.4" } } };
  fs.mkdirSync(workspace.root, { recursive: true });
  const cacheDir = path.join(dir, "tools");
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(cacheDir, "tools.json"), JSON.stringify({ retoc: { id: "retoc", version: "fake", path: process.execPath, args: ["--retoc"], verification: { kind: "none", ok: true } } }));
  const calls = [];
  const context = { workspace, toolCacheDir: cacheDir, env: {}, runProcess: async (cmd, argv) => (calls.push(argv.slice(1)), { code: 0, stdout: "", stderr: "" }) };
  const result = await executeOperation("unreal.extract_assets", { gameDir: game, filter: "DT_Tips" }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(calls[0].slice(0, 5), ["--aes-key", HEX_KEY, "to-legacy", "--filter", "DT_Tips"]);
  assert.equal(result.data.aesKeySource, "gmf.local.json");
});
