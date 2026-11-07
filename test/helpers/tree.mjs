import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Every entry under `dir` as { relative, kind, size, sha256 }, sorted by relative path.
// Directories are listed too, and links are reported as links without being followed.
export function snapshotTree(dir) {
  const entries = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        entries.push({ relative, kind: "link", size: stat.size, sha256: crypto.createHash("sha256").update(target).digest("hex") });
      } else if (stat.isDirectory()) {
        entries.push({ relative, kind: "directory", size: 0, sha256: null });
        walk(full);
      } else {
        entries.push({ relative, kind: "file", size: stat.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
      }
    }
  };
  walk(dir);
  return entries.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}
