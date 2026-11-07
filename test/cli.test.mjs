import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli/main.mjs";
import { parseArgs } from "../src/cli/args.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("version returns JSON", async () => {
  const result = await runCli(["version", "--json"], {});
  assert.equal(result.exitCode, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.data.name, "gmf");
});

test("catalog returns the operation list", async () => {
  const result = await runCli(["catalog", "--json"], {});
  assert.equal(result.exitCode, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.data.operations));
});

test("an unknown command exits 2 with an error code", async () => {
  const result = await runCli(["nope", "--json"], {});
  assert.equal(result.exitCode, 2);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, false);
  assert.equal(data.error.code, "GMF-E-USAGE-001");
});

test("parseArgs reads flags and repeated inputs", () => {
  const parsed = parseArgs([
    "run",
    "game.detect",
    "--game",
    "C:/g",
    "--input",
    "a=1",
    "--input",
    "b=2",
    "--json",
  ]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.positionals[0], "game.detect");
  assert.equal(parsed.flags.game, "C:/g");
  assert.deepEqual(parsed.flags.input, { a: "1", b: "2" });
  assert.equal(parsed.flags.json, true);
});

test("knowledge search, skill list, plan validate and tool list run through the CLI", async () => {
  const env = { GMF_ROOT: repoRoot };
  const search = JSON.parse((await runCli(["knowledge", "search", "il2cpp", "interop", "--json"], env)).stdout);
  assert.equal(search.ok, true);
  assert.ok(search.data.entries.some((entry) => entry.id === "unity.il2cpp.interop"), "the IL2CPP interop note is found");
  const skills = JSON.parse((await runCli(["skill", "list", "--json"], env)).stdout);
  assert.equal(skills.ok, true);
  assert.ok(skills.data.skills.some((skill) => skill.name === "gmf-investigate"));
  const show = JSON.parse((await runCli(["skill", "show", "gmf-investigate", "--json"], env)).stdout);
  assert.match(show.data.body, /Investigate a game/);
  const validate = JSON.parse((await runCli(["plan", "validate", "does-not-exist.json", "--json"], env)).stdout);
  assert.equal(validate.ok, false);
  assert.equal(validate.error.code, "GMF-E-PLAN-001");
  const tools = JSON.parse((await runCli(["tool", "list", "--json"], env)).stdout);
  assert.equal(tools.ok, true);
  assert.ok(tools.data.tools.length >= 12);
  const help = await runCli(["--help"], env);
  for (const name of ["plan", "verify", "games", "knowledge", "tool", "skill", "package", "setup"]) assert.ok(help.stdout.includes(`
  ${name} `), `help lists ${name}`);
});

test("string --input values are coerced to the schema's boolean, integer, number and array types", async () => {
  const { registerOperation, executeOperation } = await import("../src/core/operations.mjs");
  let received = null;
  registerOperation(
    {
      id: "test.coerce",
      title: "Coerce",
      summary: "Echo typed inputs.",
      engine: "core",
      inputs: {
        type: "object",
        properties: {
          flag: { type: "boolean" },
          count: { type: "integer" },
          ratio: { type: "number" },
          kinds: { type: "array" },
          name: { type: "string" },
        },
        required: [],
      },
      outputs: { type: "object", properties: {} },
      effects: ["read"],
      requires: [],
      gates: ["auto"],
    },
    async (inputs) => {
      received = inputs;
      return { data: {} };
    },
  );
  const ok = await executeOperation("test.coerce", { flag: "true", count: "3", ratio: "0.5", kinds: "objects,usmap", name: "true" });
  assert.equal(ok.ok, true, ok.error?.message);
  assert.deepEqual(received, { flag: true, count: 3, ratio: 0.5, kinds: ["objects", "usmap"], name: "true" });
  const json = await executeOperation("test.coerce", { kinds: '["a","b"]', flag: "false" });
  assert.equal(json.ok, true);
  assert.deepEqual(received, { kinds: ["a", "b"], flag: false });
  const bad = await executeOperation("test.coerce", { flag: "maybe", count: "3.5" });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /flag must be boolean/);
  assert.match(bad.error.message, /count must be an integer/);
});

test("gmf run from another folder still finds the framework's catalog and operations", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const elsewhere = tempDir(t, "gmf-cwd-");
  const env = { ...process.env };
  delete env.GMF_ROOT;
  const run = spawnSync(process.execPath, [path.join(repoRoot, "bin/gmf.mjs"), "catalog", "--json"], { cwd: elsewhere, env, encoding: "utf8" });
  const data = JSON.parse(run.stdout);
  assert.ok(data.data.operations.length > 0, "operations are listed outside the repository");
  assert.ok(data.data.operations.some((entry) => entry.id === "unity.remove_mod"));
});

test("the bin folder runs as a plain gmf command on this platform", async () => {
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const run =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/c", path.join(repoRoot, "bin/gmf.cmd"), "version", "--json"], { encoding: "utf8" })
      : spawnSync("sh", [path.join(repoRoot, "bin/gmf"), "version", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).data.name, "gmf");
});

test("a value flag without a value is a usage error, not a swallowed flag", async () => {
  const parsed = parseArgs(["plan", "draft", "--goal", "--json"]);
  assert.equal(parsed.flags.usageError, "--goal needs a value");
  assert.equal(parsed.flags.json, true, "the following flag is still read");
  const result = await runCli(["plan", "draft", "--goal", "--json"], {});
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "GMF-E-USAGE-001");
  assert.equal(parseArgs(["init", "--game=C:/g"]).flags.game, "C:/g");
});

test("plan draft refuses to overwrite an existing plan file unless --force is given", async (t) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = tempDir(t, "gmf-cli-draft-");
  const out = path.join(dir, "plan.json");
  fs.writeFileSync(out, '{"version":1,"goal":"keep me","steps":[],"authorizations":[]}');
  fs.writeFileSync(path.join(dir, "gmf.json"), JSON.stringify({ version: 1, game: { name: "Fixture Game", engine: "unity" } }));
  fs.writeFileSync(
    path.join(dir, "gmf.profile.json"),
    JSON.stringify({
      version: 1,
      game: { name: "Fixture Game", installDir: dir, executable: path.join(dir, "Game.exe"), sha256: null, product: null, company: null, store: { id: "manual", appId: null } },
      engine: { id: "unity", version: "2021.3.45f1", confidence: "observed", selected: true, alternatives: [] },
      runtime: { backend: "mono", architecture: "x86_64" },
      loader: { id: "bepinex5", installed: true, version: "5.4.23", path: path.join(dir, "BepInEx"), notes: [] },
      tools: [],
      capabilities: [],
      markers: { antiCheat: [], online: false, launcher: null },
      paths: { data: null, managed: null, interop: null, deploy: null, content: null, binaries: null },
      unknowns: [],
      evidence: [],
    }),
  );
  const env = { GMF_WORKSPACE: dir };
  const refused = JSON.parse((await runCli(["plan", "draft", "--goal", "new goal", "--out", out, "--json"], env)).stdout);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-USAGE-001");
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).goal, "keep me");
  const forced = JSON.parse((await runCli(["plan", "draft", "--goal", "new goal", "--out", out, "--force", "--json"], env)).stdout);
  assert.equal(forced.ok, true, forced.error?.message);
  assert.equal(forced.data.file, out);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).goal, "new goal");
});
