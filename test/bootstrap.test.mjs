import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { bootstrap } from "../src/core/bootstrap.mjs";
import { executeOperation, getHandler } from "../src/core/operations.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";

const fixture = fixturePath("dummy-engine");

test("bootstrap registers engine operations and is idempotent", async () => {
  const first = await bootstrap(repoRoot, [fixture]);
  assert.equal(first[0].id, "dummy");
  const result = await executeOperation("dummy.ping", {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.pong, true);

  const handler = getHandler("dummy.ping");
  assert.equal(typeof handler, "function");

  const second = await bootstrap(repoRoot, [fixture]);
  assert.equal(second.length, first.length);
  assert.equal(second[0].id, "dummy");
  assert.equal(getHandler("dummy.ping"), handler, "a second bootstrap keeps the registered handler");
  const again = await executeOperation("dummy.ping", {}, {});
  assert.equal(again.ok, true);
});
