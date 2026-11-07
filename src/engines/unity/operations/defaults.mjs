import fs from "node:fs";
import path from "node:path";

// The CLI runs unity operations with `gmf run <id>` and no inputs after an
// investigation. These helpers resolve the values the workspace already knows,
// so explicit inputs always win and the profile fills the gaps.

export function gameDirFor(inputs = {}, context = {}) {
  return (
    inputs.gameDir ||
    context.flags?.game ||
    context.workspace?.local?.gameDir ||
    context.workspace?.profile?.game?.installDir ||
    null
  );
}

export function backendFor(inputs = {}, context = {}) {
  return inputs.backend || context.workspace?.profile?.runtime?.backend || null;
}

export function loaderFor(inputs = {}, context = {}) {
  const loader = inputs.loader || context.workspace?.profile?.loader?.id;
  if (!loader || loader === "none" || loader === "unknown") return null;
  return loader;
}

export function modDirFor(inputs = {}, context = {}) {
  if (inputs.modDir) return path.resolve(inputs.modDir);
  if (context.flags?.modDir) return path.resolve(context.flags.modDir);
  const root = context.workspace?.root;
  if (!root) return null;
  const modsDir = path.join(root, "mods");
  if (!fs.existsSync(modsDir)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(modsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(modsDir, entry.name);
    const hasProject = fs
      .readdirSync(dir, { withFileTypes: true })
      .some((child) => child.isFile() && child.name.toLowerCase().endsWith(".csproj"));
    if (hasProject) candidates.push(dir);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function authorFor(inputs = {}, context = {}) {
  return (
    inputs.author ||
    context.flags?.author ||
    context.workspace?.config?.game?.author ||
    context.workspace?.profile?.game?.company ||
    ""
  );
}
