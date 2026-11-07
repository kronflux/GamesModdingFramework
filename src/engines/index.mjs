import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function resolveModuleFile(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const file = path.join(target, "index.mjs");
    return fs.existsSync(file) ? file : null;
  }
  return target;
}

export async function loadEngineModules(root = process.cwd(), moduleDirs = null) {
  let targets = moduleDirs;
  if (!targets) {
    const enginesDir = path.join(root, "src", "engines");
    targets = fs.existsSync(enginesDir)
      ? fs
          .readdirSync(enginesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(enginesDir, entry.name))
      : [];
  }

  const modules = [];
  for (const target of targets) {
    const file = resolveModuleFile(path.isAbsolute(target) ? target : path.join(root, target));
    if (!file) continue;
    const imported = await import(`${pathToFileURL(file).href}?v=${Date.now()}-${modules.length}`);
    const engine = imported.default || imported.engine;
    if (!engine || typeof engine.detect !== "function") {
      throw new Error(`Engine module ${file} must export a default object with detect()`);
    }
    modules.push(engine);
  }
  return modules;
}

export async function detectAll(gameDir, modules, options = {}) {
  const results = [];
  for (const engine of modules) {
    try {
      const detection = await engine.detect(gameDir, options);
      if (detection) {
        results.push({
          ...detection,
          engineModule: engine.id,
          engineCapabilities: typeof engine.capabilities === "function" ? engine.capabilities : null,
        });
      }
    } catch (error) {
      results.push({
        engine: { id: engine.id, version: null, confidence: "unknown", evidence: [] },
        error: error.message,
        engineModule: engine.id,
      });
    }
  }
  return results;
}

export function selectEngine(detections) {
  const rank = { observed: 3, derived: 2, inferred: 1, unknown: 0 };
  const sorted = [...detections].sort(
    (left, right) => (rank[right.engine?.confidence] ?? 0) - (rank[left.engine?.confidence] ?? 0),
  );
  const top = sorted[0];
  if (!top || top.engine?.confidence !== "observed") return { selected: null, alternatives: sorted };
  const tied = sorted.filter(
    (detection) => detection.engine?.confidence === "observed" && detection.engine?.id !== top.engine?.id,
  );
  if (tied.length > 0) return { selected: null, alternatives: sorted };
  return { selected: top, alternatives: sorted.slice(1) };
}
