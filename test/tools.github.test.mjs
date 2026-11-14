import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractCommand, installTool, tarCommand } from "../src/core/tools.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

const payload = Buffer.from("synthetic ue4ss proxy dll");
const digest = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;

function catalogWith(source, asset = "^UE4SS_v.*\\.dll$") {
  return {
    tools: [
      {
        id: "ue4ss",
        name: "UE4SS",
        purpose: "test",
        engine: "unreal",
        license: "MIT",
        source,
        versionPolicy: "tag",
        asset,
        entry: null,
        verify: { kind: "github-digest", value: null },
        effects: ["toolInstall", "network"],
        capabilities: [],
      },
    ],
  };
}

function fakeGithub(urls, { assetDigest = digest } = {}) {
  const release = (tag) => ({
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: [
      { name: "zDEV-UE4SS_v3.0.1-9-gabc.dll", browser_download_url: "https://dl/dev", digest: assetDigest },
      { name: "UE4SS_v3.0.1-9-gabc.dll", browser_download_url: "https://dl/regular", digest: assetDigest },
    ],
  });
  return async (url) => {
    urls.push(url);
    if (url.endsWith("/releases")) return { ok: true, json: async () => [release("experimental2"), release("experimental-latest")] };
    if (url.includes("/releases/tags/")) return { ok: true, json: async () => release(url.split("/releases/tags/")[1]) };
    return { ok: true, arrayBuffer: async () => payload };
  };
}

test("a github tool with source.tag installs that tag, not the first listed release", async (t) => {
  const urls = [];
  const cacheDir = tempDir(t, "gmf-ghtag-");
  const result = await installTool("ue4ss", {
    authorized: true,
    source: "test",
    catalog: catalogWith({ type: "github", repo: "UE4SS-RE/RE-UE4SS", tag: "experimental-latest" }),
    cacheDir,
    fetchImpl: fakeGithub(urls),
  });
  assert.ok(urls.some((url) => url.endsWith("/releases/tags/experimental-latest")), urls.join(" "));
  assert.ok(urls.includes("https://dl/regular"), "the anchored pattern picks the regular build, not zDEV");
  assert.equal(result.version, "UE4SS_v3.0.1-9-gabc");
  assert.equal(result.release, "experimental-latest");
  assert.deepEqual(result.verification, { kind: "github-digest", value: digest, ok: true });
});

test("a download whose sha256 differs from the published digest is refused", async (t) => {
  const cacheDir = tempDir(t, "gmf-ghdigest-");
  assert.deepEqual(snapshotTree(cacheDir), []);
  await assert.rejects(
    () =>
      installTool("ue4ss", {
        authorized: true,
        source: "test",
        catalog: catalogWith({ type: "github", repo: "UE4SS-RE/RE-UE4SS", tag: "experimental-latest" }),
        cacheDir,
        fetchImpl: fakeGithub([], { assetDigest: "sha256:" + "0".repeat(64) }),
      }),
    /verification failed/,
  );
  const left = snapshotTree(cacheDir);
  assert.deepEqual(left.filter((entry) => entry.kind !== "directory"), [], "a download that fails verification leaves no file in the cache");
  assert.ok(left.every((entry) => !entry.relative.includes(".tmp-")), "the temporary install folder is removed");
});

test("archives are extracted with the Windows bsdtar on win32, not a GNU tar from PATH", () => {
  const systemRoot = "C:/Windows";
  assert.equal(tarCommand("win32", { SystemRoot: systemRoot }, () => true), path.join(systemRoot, "System32", "tar.exe"));
  assert.equal(tarCommand("win32", { SystemRoot: systemRoot }, () => false), "tar");
  assert.equal(tarCommand("linux", {}, () => true), "tar");
  assert.deepEqual(extractCommand("/c/a.zip", "/d", "linux"), { command: "unzip", args: ["-q", "-o", "/c/a.zip", "-d", "/d"] });
  assert.deepEqual(extractCommand("/c/a.tar.gz", "/d", "linux"), { command: "tar", args: ["-xf", "/c/a.tar.gz", "-C", "/d"] });
  assert.equal(extractCommand("C:/c/a.zip", "C:/d", "win32").args[0], "-xf");
});

test("a tool with per-platform assets installs the asset for this platform", async (t) => {
  const urls = [];
  const cacheDir = tempDir(t, "gmf-ghplat-");
  const catalog = {
    tools: [
      {
        id: "cpp2il",
        name: "Cpp2IL",
        purpose: "test",
        engine: "unity",
        license: "MIT",
        source: { type: "github", repo: "SamboyCoding/Cpp2IL", tag: "2022.1.0-pre-release.21" },
        versionPolicy: "tag",
        assets: { win32: "^Cpp2IL-.*-Windows\.exe$", linux: "^Cpp2IL-.*-Linux$", darwin: "^Cpp2IL-.*-OSX$" },
        verify: { kind: "github-digest", value: null },
        effects: ["toolInstall", "network"],
        capabilities: [],
      },
    ],
  };
  const release = {
    tag_name: "2022.1.0-pre-release.21",
    assets: [
      { name: "Cpp2IL-2022.1.0-pre-release.21-Linux", browser_download_url: "https://dl/linux", digest },
      { name: "Cpp2IL-2022.1.0-pre-release.21-Windows-ARM64.exe", browser_download_url: "https://dl/arm", digest },
      { name: "Cpp2IL-2022.1.0-pre-release.21-Windows.exe", browser_download_url: "https://dl/win", digest },
      { name: "Cpp2IL-2022.1.0-pre-release.21-OSX", browser_download_url: "https://dl/osx", digest },
    ],
  };
  const downloadFor = { win32: "https://dl/win", linux: "https://dl/linux", darwin: "https://dl/osx" };
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("/releases/tags/")) return { ok: true, json: async () => release };
    return { ok: true, arrayBuffer: async () => payload };
  };
  const { installTool: install, selectAssetFor } = await import("../src/core/tools.mjs");
  assert.equal(selectAssetFor(catalog.tools[0], release, "linux").name, "Cpp2IL-2022.1.0-pre-release.21-Linux");
  assert.equal(selectAssetFor(catalog.tools[0], release, "win32").name, "Cpp2IL-2022.1.0-pre-release.21-Windows.exe");
  assert.equal(selectAssetFor(catalog.tools[0], release, "darwin").name, "Cpp2IL-2022.1.0-pre-release.21-OSX");
  await install("cpp2il", { authorized: true, source: "test", catalog, cacheDir, fetchImpl });
  const expected = downloadFor[process.platform];
  if (expected) {
    assert.ok(urls.includes(expected), urls.join(" "));
    const others = Object.values(downloadFor).filter((url) => url !== expected);
    assert.deepEqual(urls.filter((url) => others.includes(url)), [], "no other platform's asset is downloaded");
  }
});

test("a failed download keeps the previous install and its manifest entry", async (t) => {
  const cacheDir = tempDir(t, "gmf-ghkeep-");
  const catalog = catalogWith({ type: "github", repo: "UE4SS-RE/RE-UE4SS", tag: "experimental-latest" });
  const first = await installTool("ue4ss", { authorized: true, source: "test", catalog, cacheDir, fetchImpl: fakeGithub([]) });
  assert.ok(fs.existsSync(first.path));
  const failing = async (url) => (url.includes("/releases/tags/") ? fakeGithub([])(url) : { ok: false, status: 500 });
  await assert.rejects(() => installTool("ue4ss", { authorized: true, source: "test", catalog, cacheDir, fetchImpl: failing }), /Download failed: 500/);
  assert.ok(fs.existsSync(first.path), "the previous binary is still there");
  const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "tools.json"), "utf8"));
  assert.equal(manifest.ue4ss.path, first.path);
  assert.ok(fs.readdirSync(path.join(cacheDir, "ue4ss")).every((name) => !name.includes(".tmp-")), "no temp folder is left behind");
});

test("an asset name with path segments is reduced to its base name inside the cache", async (t) => {
  const cacheDir = tempDir(t, "gmf-ghname-");
  const release = { tag_name: "v1", assets: [{ name: "../../evil.dll", browser_download_url: "https://dl/evil", digest }] };
  const fetchImpl = async (url) => (url.includes("/releases/tags/") ? { ok: true, json: async () => release } : { ok: true, arrayBuffer: async () => payload });
  const result = await installTool("ue4ss", {
    authorized: true,
    source: "test",
    catalog: catalogWith({ type: "github", repo: "x/y", tag: "v1" }, ".*"),
    cacheDir,
    fetchImpl,
  });
  assert.equal(path.basename(result.path), "evil.dll");
  assert.ok(result.path.startsWith(path.join(cacheDir, "ue4ss")), result.path);
  assert.equal(fs.existsSync(path.join(path.dirname(cacheDir), "evil.dll")), false);
});
