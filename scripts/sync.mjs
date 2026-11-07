import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncHosts } from "../src/core/hosts.mjs";

export function sync({ root = process.cwd(), check = false } = {}) {
  const result = syncHosts({ root, check });
  if (check) {
    if (result.ok) {
      console.log("host files are current");
    } else {
      console.error(`host drift: ${result.drift.join(", ")}`);
    }
  } else {
    console.log(`wrote ${result.written.length} host files`);
  }
  return result;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = sync({ root: process.cwd(), check: process.argv.slice(2).includes("--check") });
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
