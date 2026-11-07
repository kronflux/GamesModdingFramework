import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMcpServer, PROTOCOL_VERSIONS } from "../src/mcp/server.mjs";
import { loadCatalog } from "../src/core/catalog.mjs";
import { runCli } from "../src/cli/main.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir, tempRoot } from "./helpers/tmp.mjs";

const root = repoRoot;
const server = () => createMcpServer({ root, env: {}, cwd: tempRoot("gmf-mcp-cwd-") });
const call = (s, id, method, params) => s.handle({ jsonrpc: "2.0", id, method, params });

test("initialize echoes a supported protocol version and offers the newest otherwise", async () => {
  const s = server();
  const known = await call(s, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(known.result.protocolVersion, "2025-06-18");
  assert.equal(known.result.serverInfo.name, "gmf");
  assert.ok(known.result.capabilities.tools);
  const unknown = await call(s, 2, "initialize", { protocolVersion: "1900-01-01", capabilities: {} });
  assert.equal(unknown.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "notifications get no reply");
});

test("tools/list has one valid tool per catalog operation, with authorization inputs on gated ones", async () => {
  const s = server();
  const { result } = await call(s, 1, "tools/list", {});
  const operations = loadCatalog(root).operations;
  assert.equal(result.tools.length, operations.length);
  for (const tool of result.tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/, tool.name);
    assert.equal(tool.inputSchema.type, "object");
  }
  const remove = result.tools.find((tool) => tool.name === "unity_remove_mod");
  assert.ok(remove.inputSchema.properties.name);
  assert.ok(remove.inputSchema.properties.authorized);
  assert.ok(remove.inputSchema.properties.authorizationSource);
  const search = result.tools.find((tool) => tool.name === "knowledge_search");
  assert.equal(search.inputSchema.properties.authorized, undefined, "auto operations take no authorization");
  assert.equal(search.annotations.readOnlyHint, true);
});

test("tools/call runs the operation through the executor and its gates", async (t) => {
  const s = server();
  const search = await call(s, 1, "tools/call", { name: "knowledge_search", arguments: { query: "bepinex" } });
  assert.equal(search.result.isError, false);
  assert.equal(search.result.structuredContent.ok, true);
  assert.equal(JSON.parse(search.result.content[0].text).ok, true);

  const target = path.join(tempDir(t, "gmf-mcp-"), "file.txt");
  fs.writeFileSync(target, "keep");
  const gated = await call(s, 2, "tools/call", { name: "generic_restore", arguments: { gamePath: target } });
  assert.equal(gated.result.isError, true);
  assert.equal(gated.result.structuredContent.error.code, "GMF-E-GATE-001");
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

test("unknown tools and methods are JSON-RPC errors; server/discover sends modern clients to initialize", async () => {
  const s = server();
  assert.equal((await call(s, 1, "tools/call", { name: "no_such_tool", arguments: {} })).error.code, -32602);
  assert.equal((await call(s, 2, "server/discover", {})).error.code, -32601);
  assert.deepEqual((await call(s, 3, "ping", {})).result, {});
});

test("gmf mcp speaks newline-delimited JSON-RPC and writes nothing else to stdout", async () => {
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    "not json",
  ].join("\n");
  const result = await runCli(["mcp"], { GMF_ROOT: root }, { stdin: `${lines}\n` });
  const out = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((message) => message.id ?? null).sort(), [1, 2, null].sort());
  assert.equal(out.find((message) => message.error)?.error.code, -32700);
});

test("every tool takes an optional workspace folder, used instead of the server's working folder", async (t) => {
  const s = server();
  const { result } = await call(s, 1, "tools/list", {});
  for (const tool of result.tools) assert.ok(tool.inputSchema.properties.workspace, tool.name);
  const ws = tempDir(t, "gmf-mcp-ws-");
  fs.writeFileSync(path.join(ws, "gmf.json"), JSON.stringify({ version: 1, name: "probe" }));
  fs.mkdirSync(path.join(ws, "dumps"));
  fs.writeFileSync(path.join(ws, "gmf.profile.json"), JSON.stringify({ version: 1, engine: { id: "unity" } }));
  fs.writeFileSync(
    path.join(ws, "dumps", "unity-mono.json"),
    JSON.stringify({ version: 1, engine: "unity", entrypoints: [], classes: [{ name: "ProbeStamina", namespace: "", methods: ["Drain"], fields: [] }], objects: [], references: [], assets: [], strings: [] }),
  );
  const found = await call(s, 2, "tools/call", { name: "analyze_classes", arguments: { workspace: ws, profile: "gmf.profile.json", query: "ProbeStamina" } });
  assert.equal(found.result.isError, false, found.result.content[0].text);
  assert.equal(found.result.structuredContent.data.results[0].name, "ProbeStamina");
});
