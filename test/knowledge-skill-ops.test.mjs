// knowledge.show, skill.list and skill.show are catalog operations, so the CLI,
// gmf run and MCP clients (which get no plugin skills) all reach them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import { bootstrap } from "../src/core/bootstrap.mjs";
import { loadCatalog } from "../src/core/catalog.mjs";
import { createMcpServer } from "../src/mcp/server.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const root = repoRoot;
const context = { root, catalog: loadCatalog(root) };
await bootstrap(root);

test("knowledge.show returns a note's metadata and body; an unknown id is a plan error", async () => {
  const shown = await executeOperation("knowledge.show", { id: "unity.asset-tools" }, context);
  assert.equal(shown.ok, true, shown.error?.message);
  assert.equal(shown.data.id, "unity.asset-tools");
  assert.match(shown.data.body, /AssetStudioModCLI/);
  const missing = await executeOperation("knowledge.show", { id: "no.such.note" }, context);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "GMF-E-PLAN-001");
});

test("skill.list lists every skill and skill.show returns one skill's body", async () => {
  const listed = await executeOperation("skill.list", {}, context);
  assert.equal(listed.ok, true, listed.error?.message);
  assert.equal(listed.data.skills.length, context.catalog.skills.length);
  assert.ok(listed.data.skills.some((skill) => skill.name === "unity-assets"));
  const shown = await executeOperation("skill.show", { name: "unity-assets" }, context);
  assert.equal(shown.ok, true, shown.error?.message);
  assert.match(shown.data.body, /unity\.extract_assets/);
});

test("the MCP server offers every skill as a prompt", async (t) => {
  const server = createMcpServer({ root, env: {}, cwd: tempDir(t, "gmf-mcp-prompts-") });
  const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
  assert.ok(init.result.capabilities.prompts, "prompts capability declared");
  const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} });
  const prompt = list.result.prompts.find((entry) => entry.name === "unity-assets");
  assert.ok(prompt && prompt.description, "unity-assets is a prompt with a description");
  assert.equal(list.result.prompts.length, context.catalog.skills.length);
  const got = await server.handle({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "unity-assets" } });
  assert.equal(got.result.messages[0].role, "user");
  assert.match(got.result.messages[0].content.text, /unity\.extract_assets/);
  const unknown = await server.handle({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "nope" } });
  assert.equal(unknown.error.code, -32602);
  const tools = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
  assert.ok(tools.result.tools.some((tool) => tool.name === "knowledge_show"));
});

test("skill prompts and server instructions say how gmf commands map to MCP tools", async (t) => {
  const server = createMcpServer({ root, env: {}, cwd: tempDir(t, "gmf-mcp-map-") });
  const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
  assert.match(init.result.instructions, /gmf run unity\.deploy --input modDir=X.*unity_deploy/);
  const got = await server.handle({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "unity-assets" } });
  assert.match(got.result.messages[0].content.text, /^Over MCP, run each `gmf run <operation>`/);
});

test("knowledge.search reports each note's confidence as its evidence confidence", async () => {
  const note = (id, confidence) => ({ id, title: id, engine: "core", tags: [], summary: "needle", body: "", path: `knowledge/${id}.md`, confidence });
  const knowledge = [note("a.observed", "observed"), note("b.derived", "derived"), note("c.verified", "verified"), note("d.inferred", "inferred"), note("e.other", "guess")];
  const result = await executeOperation("knowledge.search", { query: "needle" }, { root, knowledge });
  assert.equal(result.ok, true, result.error?.message);
  const byId = Object.fromEntries(result.evidence.map((record) => [record.detail.id, record.confidence]));
  assert.deepEqual(byId, {
    "a.observed": "observed",
    "b.derived": "derived",
    "c.verified": "observed",
    "d.inferred": "inferred",
    "e.other": "inferred",
  });
});
