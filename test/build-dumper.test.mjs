import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildPlan, writeBuildJson, parseArgs, packageNative } from "../scripts/build-dumper.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("buildPlan names the Ninja generator, the shipping configuration, the UE4SS tree and the target", () => {
  const plan = buildPlan({ ue4ss: path.join("X:", "ue4ss"), buildDir: path.join("X:", "build") });
  assert.equal(plan.configure[0], "cmake");
  assert.deepEqual(plan.configure.slice(1, 5), ["-S", path.join(repoRoot, "native", "gmfdumper"), "-B", path.join("X:", "build")]);
  assert.ok(plan.configure.includes("Ninja"));
  assert.ok(plan.configure.includes("-DCMAKE_BUILD_TYPE=Game__Shipping__Win64"));
  assert.ok(plan.configure.includes(`-DGMF_UE4SS_SOURCE_DIR=${path.join("X:", "ue4ss").split(path.sep).join("/")}`));
  assert.deepEqual(plan.build, ["cmake", "--build", path.join("X:", "build"), "--target", "GmfDumper"]);
  assert.equal(plan.dll, path.join("X:", "build", "main.dll"));
});

test("writeBuildJson writes the schema id and the four fields", (t) => {
  const dir = tempDir(t, "gmf-build-json-");
  const file = writeBuildJson(dir, {
    ue4ssAsset: "UE4SS_v3.0.1-1217-g4fb9b615.zip",
    ue4ssDigest: "sha256:abc",
    sourceHash: "0123",
    builtAt: "2026-11-13T00:00:00.000Z",
  });
  assert.equal(file, path.join(dir, "build.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    schema: "gmfdumper.build/1",
    ue4ss_asset: "UE4SS_v3.0.1-1217-g4fb9b615.zip",
    ue4ss_digest: "sha256:abc",
    source_hash: "0123",
    built_at: "2026-11-13T00:00:00.000Z",
  });
});

test("parseArgs needs --ue4ss and keeps the asset name and digest", () => {
  assert.throws(() => parseArgs([]), /--ue4ss/);
  const args = parseArgs(["--ue4ss", "C:/src", "--out", "o", "--ue4ss-asset", "A.zip", "--ue4ss-digest", "sha256:1"]);
  assert.equal(args.ue4ss, path.resolve("C:/src"));
  assert.equal(args.out, path.resolve("o"));
  assert.equal(args.ue4ssAsset, "A.zip");
  assert.equal(args.ue4ssDigest, "sha256:1");
});

test("packageNative writes a zip holding dlls/main.dll and build.json, and build.json beside it", (t) => {
  const dir = tempDir(t, "gmf-build-pack-");
  const dll = path.join(dir, "main.dll");
  fs.writeFileSync(dll, Buffer.from([0x4d, 0x5a, 0, 0]));
  const out = path.join(dir, "out");
  const result = packageNative({ dll, out, build: { ue4ssAsset: "A.zip", ue4ssDigest: null, sourceHash: "h", builtAt: "t" } });
  assert.equal(result.zip, path.join(out, "GmfDumper-native.zip"));
  const bytes = fs.readFileSync(result.zip).toString("latin1");
  assert.ok(bytes.includes("dlls/main.dll"));
  assert.ok(bytes.includes("build.json"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "build.json"), "utf8")).ue4ss_asset, "A.zip");
  assert.deepEqual(fs.readdirSync(out).sort(), ["GmfDumper-native.zip", "build.json"]);
});

test("cachedSourceDir reads the UE4SS tree a build folder was configured for", async () => {
  const { cachedSourceDir } = await import("../scripts/build-dumper.mjs");
  const cache = "# comment\nCMAKE_BUILD_TYPE:STRING=Game__Shipping__Win64\nGMF_UE4SS_SOURCE_DIR:PATH=C:/src/ue4ss-a\n";
  assert.equal(cachedSourceDir(cache), "C:/src/ue4ss-a");
  assert.equal(cachedSourceDir("CMAKE_BUILD_TYPE:STRING=x\n"), null);
});
