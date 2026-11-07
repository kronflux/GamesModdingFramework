import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./helpers/paths.mjs";

const root = repoRoot;
const files = ["README.md", "AGENTS.md"];

for (const name of fs.readdirSync(path.join(root, "docs"), { recursive: true })) {
  if (String(name).endsWith(".md")) files.push(path.join("docs", String(name)));
}

test("every relative Markdown link resolves", () => {
  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(path.join(root, file)), target);
      if (!fs.existsSync(resolved)) missing.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("README counts equal the catalog counts", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const match = readme.match(/(\d+) operations, (\d+) tool registrations, (\d+) knowledge notes, (\d+) templates and (\d+) skills/);
  assert.ok(match, "README status line with counts is missing");
  const catalog = {};
  for (const kind of ["operations", "tools", "knowledge", "templates", "skills"]) {
    catalog[kind] = JSON.parse(fs.readFileSync(path.join(root, "catalog", `${kind}.json`), "utf8"))[kind].length;
  }
  assert.deepEqual(match.slice(1).map(Number), [catalog.operations, catalog.tools, catalog.knowledge, catalog.templates, catalog.skills]);
});

test("no doc names the vendor or logs commands struck from the spec", () => {
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(/gmf (vendor|logs)\b/g)) hits.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(hits, []);
});

test("gmf version reports the package.json version", async () => {
  const { runCli } = await import("../src/cli/main.mjs");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const result = JSON.parse((await runCli(["version", "--json"], { GMF_ROOT: root })).stdout);
  assert.equal(result.data.version, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});
