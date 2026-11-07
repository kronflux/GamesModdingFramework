import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/main.mjs";
import { buildCatalog } from "../scripts/build-catalog.mjs";
import { repoRoot } from "./helpers/paths.mjs";

const root = repoRoot;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-accept-"));
const workspace = path.join(tmp, "workspace");
const env = { GMF_ROOT: root, GMF_WORKSPACE: workspace };

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function cli(args) {
  const result = await runCli(args, env);
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function snapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.statSync(full);
      entries.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries.sort();
}

test("the generated catalog contains every engine and shared operation", async () => {
  const data = await buildCatalog({ root, check: true });
  const ids = new Set(data.operations.map((operation) => operation.id));
  for (const id of [
    "game.detect",
    "game.profile",
    "workspace.init",
    "unity.decompile",
    "unity.scaffold",
    "unity.build",
    "unreal.setup_ue4ss",
    "unreal.deploy",
    "analyze.classes",
    "plan.apply",
    "knowledge.search",
  ]) {
    assert.ok(ids.has(id), `missing operation ${id}`);
  }
  assert.ok(data.tools.length >= 9, `expected at least 9 tools, got ${data.tools.length}`);
  assert.ok(data.knowledge.length >= 12, `expected at least 12 knowledge notes, got ${data.knowledge.length}`);
  assert.ok(data.skills.length >= 8, `expected at least 8 skills, got ${data.skills.length}`);
});

test("CLI detection identifies Unity Mono, Unity IL2CPP and Unreal", async () => {
  const cases = [
    ["test/fixtures/unity-mono", "unity", "mono", "bepinex5"],
    ["test/fixtures/unity-il2cpp", "unity", "il2cpp", "bepinex6"],
    ["test/fixtures/unreal/ue4ss-game", "unreal", "native", "ue4ss"],
  ];
  for (const [fixture, engine, backend, loader] of cases) {
    const result = await cli(["detect", "--game", path.join(root, fixture), "--json"]);
    assert.equal(result.exitCode, 0, `${fixture}: ${result.json?.error?.message}`);
    assert.equal(result.json.data.profile.engine.id, engine, fixture);
    assert.equal(result.json.data.profile.runtime.backend, backend, fixture);
    assert.equal(result.json.data.profile.loader.id, loader, fixture);
    if (engine === "unreal") {
      assert.match(result.json.data.profile.game.executable, /Game-Win64-Shipping\.exe$/);
      assert.ok(result.json.data.profile.capabilities.some((capability) => capability.id === "code"));
      assert.ok(result.json.data.profile.capabilities.some((capability) => capability.id === "pak"));
    }
  }
});

test("investigate writes a profile and does not modify the game", async () => {
  const fixture = path.join(root, "test/fixtures/unity-mono");
  const before = snapshot(fixture);
  const result = await cli(["investigate", "--game", fixture, "--workspace", workspace, "--json"]);
  assert.equal(result.exitCode, 0, result.json?.error?.message);
  assert.ok(fs.existsSync(path.join(workspace, "gmf.json")));
  assert.ok(fs.existsSync(path.join(workspace, "gmf.local.json")));
  assert.ok(fs.existsSync(path.join(workspace, "gmf.profile.json")));
  const profile = JSON.parse(fs.readFileSync(path.join(workspace, "gmf.profile.json"), "utf8"));
  assert.equal(profile.engine.id, "unity");
  assert.deepEqual(snapshot(fixture), before);
});

test("knowledge search through the CLI returns metadata and a path", async () => {
  const result = await cli(["run", "knowledge.search", "--input", "query=il2cpp interop", "--json"]);
  assert.equal(result.exitCode, 0, result.json?.error?.message);
  assert.ok(result.json.data.entries.length >= 1);
  assert.match(result.json.data.entries[0].path, /^knowledge\//);
});

test("host manifests, hooks and skills are present", () => {
  for (const file of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    ".codex-plugin/hooks.json",
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  assert.ok(fs.existsSync(path.join(root, "skills/gmf-investigate/SKILL.md")));
});
