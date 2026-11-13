// Builds the native part of GmfDumper (native/gmfdumper) against one RE-UE4SS source tree and
// packages it as the rolling release asset: GmfDumper-native.zip (dlls/main.dll and build.json)
// with build.json beside it.
//
//   node scripts/build-dumper.mjs --ue4ss <RE-UE4SS checkout with submodules>
//        [--out dist] [--build-dir <temp folder>/gmfdumper-build]
//        [--ue4ss-asset UE4SS_v...zip] [--ue4ss-digest sha256:...] [--config Game__Shipping__Win64]
//
// Needs CMake, Ninja, MSVC and a Rust toolchain, as the UE4SS build does. Windows only: the DLL is
// loaded into the game's Windows process on every system.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createZip } from "../src/engines/unreal/operations/zip.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_DIR = path.join(REPO_ROOT, "native", "gmfdumper");
const TARGET = "GmfDumper";
const DEFAULT_CONFIG = "Game__Shipping__Win64";
// Outside the repository: the build tree holds DLLs, which the content gate refuses.
const DEFAULT_BUILD_DIR = path.join(os.tmpdir(), "gmfdumper-build");

export function parseArgs(argv) {
  const args = { ue4ss: null, out: path.resolve("dist"), buildDir: DEFAULT_BUILD_DIR, config: DEFAULT_CONFIG, ue4ssAsset: null, ue4ssDigest: null };
  const names = { "--ue4ss": "ue4ss", "--out": "out", "--build-dir": "buildDir", "--config": "config", "--ue4ss-asset": "ue4ssAsset", "--ue4ss-digest": "ue4ssDigest" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = names[argv[i]];
    if (!key) throw new Error(`unknown argument: ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${argv[i]} needs a value`);
    args[key] = value;
    i += 1;
  }
  if (!args.ue4ss) throw new Error("--ue4ss <RE-UE4SS checkout> is required");
  for (const key of ["ue4ss", "out", "buildDir"]) args[key] = path.resolve(args[key]);
  return args;
}

// The two commands of a build and where the DLL lands. CMake takes forward slashes in -D paths.
export function buildPlan({ ue4ss, buildDir = DEFAULT_BUILD_DIR, config = DEFAULT_CONFIG }) {
  return {
    configure: [
      "cmake", "-S", SOURCE_DIR, "-B", buildDir, "-G", "Ninja",
      `-DCMAKE_BUILD_TYPE=${config}`,
      `-DGMF_UE4SS_SOURCE_DIR=${ue4ss.split(path.sep).join("/")}`,
    ],
    build: ["cmake", "--build", buildDir, "--target", TARGET],
    dll: path.join(buildDir, "main.dll"),
  };
}

export function writeBuildJson(dir, { ue4ssAsset, ue4ssDigest, sourceHash, builtAt }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "build.json");
  const data = {
    schema: "gmfdumper.build/1",
    ue4ss_asset: ue4ssAsset ?? null,
    ue4ss_digest: ue4ssDigest ?? null,
    source_hash: sourceHash ?? null,
    built_at: builtAt,
  };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

// Writes <out>/GmfDumper-native.zip and <out>/build.json, and nothing else into <out>.
export function packageNative({ dll, out, build }) {
  fs.mkdirSync(out, { recursive: true });
  const buildJson = writeBuildJson(out, build);
  const zip = path.join(out, "GmfDumper-native.zip");
  createZip(zip, [
    { file: dll, name: "dlls/main.dll" },
    { file: buildJson, name: "build.json" },
  ]);
  return { zip, buildJson };
}

// The git tree hash of native/gmfdumper at HEAD: it changes exactly when the native source does.
export function sourceHash() {
  const result = spawnSync("git", ["rev-parse", "HEAD:native/gmfdumper"], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// The environment of a Visual Studio x64 developer prompt, or the current one when cl.exe is
// already on PATH.
function msvcEnvironment() {
  const probe = spawnSync("where", ["cl.exe"], { encoding: "utf8" });
  if (probe.status === 0) return process.env;
  const vswhere = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const install = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : "";
  if (!install) throw new Error("Visual Studio with the C++ tools was not found (vswhere returned nothing).");
  const vcvars = path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
  // With /s, cmd removes the first and the last quote of the command, so the whole command is
  // wrapped in one more pair to keep the quotes around the path.
  const dump = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${vcvars}" >nul && set"`], { encoding: "utf8", windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error(`vcvars64.bat failed: ${dump.stderr}`);
  const env = {};
  for (const line of dump.stdout.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

function run(command, env) {
  console.log(`> ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} ${command[1]} failed with exit code ${result.status}`);
}

export function main(argv) {
  const args = parseArgs(argv);
  if (process.platform !== "win32") throw new Error("The native part is a Windows DLL and is built on Windows.");
  if (!fs.existsSync(path.join(args.ue4ss, "CMakeLists.txt"))) throw new Error(`No CMakeLists.txt in ${args.ue4ss}`);
  const env = { ...msvcEnvironment() };
  // UE4SS's patternsleuth dependency asks for a nightly Rust toolchain; it builds with stable.
  if (!env.RUSTUP_TOOLCHAIN) env.RUSTUP_TOOLCHAIN = "stable";
  const plan = buildPlan(args);
  if (!fs.existsSync(path.join(args.buildDir, "build.ninja"))) run(plan.configure, env);
  run(plan.build, env);
  if (!fs.existsSync(plan.dll)) throw new Error(`The build ended without ${plan.dll}`);
  const result = packageNative({
    dll: plan.dll,
    out: args.out,
    build: { ue4ssAsset: args.ue4ssAsset, ue4ssDigest: args.ue4ssDigest, sourceHash: sourceHash(), builtAt: new Date().toISOString() },
  });
  console.log(`${result.zip} (${fs.statSync(result.zip).size} bytes, main.dll ${fs.statSync(plan.dll).size} bytes)`);
  console.log(result.buildJson);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`build-dumper: ${error.message}`);
    process.exit(1);
  }
}
