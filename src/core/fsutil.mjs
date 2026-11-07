// File helpers shared by core, engines and scripts: a JSON read that tells a
// missing file from a broken one, an atomic JSON write, path containment that
// follows existing symlinks, and a readdir that never throws.
import fs from "node:fs";
import path from "node:path";

export function fileError(code, message, remediation) {
  const error = new Error(message);
  error.code = code;
  if (remediation) error.remediation = remediation;
  return error;
}

// Returns fallback only when the file does not exist. Any other failure, such
// as a syntax error or a permission error, throws GMF-E-FILE-002 naming the file.
export function readJson(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw fileError("GMF-E-FILE-002", `GMF-E-FILE-002: cannot read ${file}: ${error.message}`, "Fix the file's permissions, or move it away if it should be recreated.");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw fileError("GMF-E-FILE-002", `GMF-E-FILE-002: ${file} is not valid JSON: ${error.message}`, "Repair the file by hand, or move it away so gmf can write a fresh one.");
  }
}

// Writes JSON to a temp file beside the target and renames it into place.
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// A symlink whose target does not exist: existsSync follows it and says no,
// lstat still finds the link.
function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

// The deepest existing ancestor of target, resolved through symlinks, joined
// with the rest of the path as written. null when a dangling symlink is on the
// way, because its target cannot be checked.
function realish(target) {
  const absolute = path.resolve(target);
  let existing = absolute;
  const rest = [];
  while (!fs.existsSync(existing)) {
    if (isSymlink(existing)) return null;
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try {
    real = fs.realpathSync.native(existing);
  } catch {
    real = existing;
  }
  return path.join(real, ...rest);
}

// True when target is root or lies under it. A name such as "..foo" is inside;
// ".." and anything through it are not; symlinks that exist are followed.
export function isInside(root, target) {
  const base = realish(root);
  const candidate = realish(target);
  if (base === null || candidate === null) return false;
  const relative = path.relative(base, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

// readdirSync that returns [] instead of throwing, sorted by name.
export function safeReaddir(dir, options = undefined) {
  try {
    const entries = fs.readdirSync(dir, options);
    return entries.sort((a, b) => String(a.name ?? a).localeCompare(String(b.name ?? b), "en"));
  } catch {
    return [];
  }
}
