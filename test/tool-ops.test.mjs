import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toolListOperation, toolInstallOperation, toolVerifyOperation } from "../src/operations/tool/index.mjs";
import { loadCatalog } from "../src/core/catalog.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

const root = repoRoot;
const catalog = loadCatalog(root);

test("tool.list reports every registered tool with an install flag", async (t) => {
  const cacheDir = tempDir(t, "gmf-toolcache-");
  const result = await toolListOperation.handler({}, { catalog, toolCacheDir: cacheDir });
  assert.equal(result.data.tools.length, catalog.tools.length);
  for (const tool of result.data.tools) assert.equal(typeof tool.installed, "boolean");
  const unity = await toolListOperation.handler({ engine: "unity" }, { catalog, toolCacheDir: cacheDir });
  assert.ok(unity.data.tools.length > 0, "the Unity filter keeps some tools");
  assert.ok(unity.data.tools.some((tool) => tool.engine === "unity"));
  assert.ok(unity.data.tools.every((tool) => tool.engine === "unity" || tool.engine === "core"));
  assert.ok(result.data.tools.some((tool) => tool.engine === "unreal"), "the unfiltered list has Unreal tools");
  assert.equal(unity.data.tools.some((tool) => tool.engine === "unreal"), false, "the Unity filter drops them");
});

test("tool.install without a toolInstall authorization is refused with GMF-E-GATE-001", async (t) => {
  const cacheDir = tempDir(t, "gmf-toolcache-");
  const before = snapshotTree(cacheDir);
  let fetchCalls = 0;
  await assert.rejects(
    () =>
      toolInstallOperation.handler(
        { tool: "cpp2il" },
        { catalog, toolCacheDir: cacheDir, fetch: async () => { fetchCalls += 1; throw new Error("no network"); } },
      ),
    /GMF-E-GATE-001/,
  );
  assert.equal(fetchCalls, 0, "a refused install never reaches the network");
  assert.deepEqual(snapshotTree(cacheDir), before, "a refused install writes nothing to the cache");
});

test("tool.verify reports an uninstalled tool as not ok", async (t) => {
  const cacheDir = tempDir(t, "gmf-toolcache-");
  const result = await toolVerifyOperation.handler({ tool: "cpp2il" }, { catalog, toolCacheDir: cacheDir });
  assert.equal(result.data.ok, false);
  assert.match(result.data.reason, /not installed/);
});
