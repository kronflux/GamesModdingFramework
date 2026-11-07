// Every gmf command the documentation names must be a command the dispatcher
// knows, and every runnable example must return ok or a documented error code,
// never GMF-E-USAGE-001 "Unknown command".

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS, runCli } from "../src/cli/main.mjs";
import { splitCommand } from "../src/operations/verify/plan.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const root = repoRoot;

function docFiles() {
  const files = ["README.md", "AGENTS.md"];
  for (const name of fs.readdirSync(path.join(root, "docs"))) if (name.endsWith(".md")) files.push(path.join("docs", name));
  for (const name of fs.readdirSync(path.join(root, "skills"))) {
    const skill = path.join("skills", name, "SKILL.md");
    if (fs.existsSync(path.join(root, skill))) files.push(skill);
  }
  return files;
}

// Collect "gmf ..." lines from fenced blocks and from inline code spans.
function commandLines(text) {
  const lines = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      const line = raw.replace(/^\s*(\$|>)\s*/, "").trim();
      if (/^(node bin\/gmf\.mjs|gmf)\s/.test(line)) lines.push(line);
      continue;
    }
    for (const match of raw.matchAll(/`((?:node bin\/gmf\.mjs|gmf) [^`]+)`/g)) lines.push(match[1]);
  }
  return lines;
}

function isSynopsis(line) {
  return /[\[\]|<>]/.test(line) || line.includes("...");
}

test("every command the documentation names is a dispatcher command", () => {
  const unknown = [];
  for (const file of docFiles()) {
    for (const line of commandLines(fs.readFileSync(path.join(root, file), "utf8"))) {
      const args = splitCommand(line.replace(/^node bin\/gmf\.mjs/, "gmf"));
      const name = args[1];
      if (!name || name.startsWith("--")) continue;
      if (!Object.hasOwn(COMMANDS, name)) unknown.push(`${file}: ${line}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test("every runnable documented command returns ok or a documented error, never Unknown command", async (t) => {
  const workspace = tempDir(t, "gmf-cli-docs-");
  const failures = [];
  const seen = new Set();
  for (const file of docFiles()) {
    for (const line of commandLines(fs.readFileSync(path.join(root, file), "utf8"))) {
      if (isSynopsis(line) || seen.has(line)) continue;
      seen.add(line);
      const args = splitCommand(line.replace(/^node bin\/gmf\.mjs/, "gmf")).slice(1);
      if (args.includes("--install")) continue; // never download during tests
      if (!args.includes("--json")) args.push("--json");
      const result = await runCli(args, { GMF_ROOT: root, GMF_WORKSPACE: workspace }, { stdin: "" });
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = null;
      }
      if (!parsed) continue; // hook events print context text, not JSON
      if (!parsed.ok && parsed.error?.code === "GMF-E-USAGE-001" && /Unknown command/.test(parsed.error.message)) {
        failures.push(`${file}: ${line} -> ${parsed.error.message}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the ten basic commands exist", async (t) => {
  const workspace = tempDir(t, "gmf-cli-ten-");
  const env = { GMF_ROOT: root, GMF_WORKSPACE: workspace };
  const cases = [
    ["knowledge", "search", "il2cpp"],
    ["plan", "validate", "missing.json"],
    ["plan", "apply", "missing.json"],
    ["games"],
    ["verify"],
    ["setup"],
    ["tool", "list"],
    ["skill", "list"],
    ["package"],
  ];
  for (const argv of cases) {
    const result = await runCli([...argv, "--json"], env);
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.ok || parsed.error.code !== "GMF-E-USAGE-001" || !/Unknown command/.test(parsed.error.message),
      `${argv.join(" ")} -> ${JSON.stringify(parsed.error || parsed.data).slice(0, 120)}`,
    );
  }
  const vendor = JSON.parse((await runCli(["vendor", "--json"], env)).stdout);
  assert.equal(vendor.error.code, "GMF-E-USAGE-001", "vendor was struck from the spec");
});
