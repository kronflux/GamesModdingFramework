import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEngineModules } from "../engines/index.mjs";
import { getHandler, registerOperation } from "./operations.mjs";

async function loadSharedOperations(root) {
  const dir = path.join(root, "src", "operations");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, "index.mjs"))
    .filter((file) => fs.existsSync(file));

  const operations = [];
  for (const file of files) {
    const imported = await import(`${pathToFileURL(file).href}?v=${Date.now()}-${operations.length}`);
    const exported = imported.operations || imported.default;
    if (Array.isArray(exported)) operations.push(...exported);
  }
  return operations;
}

// Load engine modules and shared operation modules, then register their public
// operations. Idempotent: a handler already registered by a unit test is left
// alone.
export async function bootstrap(root = process.cwd(), moduleDirs = null) {
  const modules = await loadEngineModules(root, moduleDirs);
  const operations = [];

  for (const engine of modules) {
    const engineOperations = typeof engine.operations === "function" ? await engine.operations() : engine.operations || [];
    operations.push(...engineOperations);
  }
  if (moduleDirs === null) operations.push(...(await loadSharedOperations(root)));

  for (const operation of operations) {
    if (!operation || typeof operation.handler !== "function") continue;
    if (!getHandler(operation.id)) registerOperation(operation, operation.handler);
  }
  return modules;
}
