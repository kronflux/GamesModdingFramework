import path from "node:path";
import { fileURLToPath } from "node:url";

// The repository root, derived from this file so tests do not depend on the working directory.
export const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// A path under test/fixtures.
export function fixture(...parts) {
  return path.join(repoRoot, "test", "fixtures", ...parts);
}
