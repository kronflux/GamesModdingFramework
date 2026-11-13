// Pages for assets that have no page of their own: every loaded asset the dumper wrote to
// Assets/asset_values.jsonl (sound classes, input actions, physical materials and so on),
// one page per asset that has values.

import { get, keys, leaf, or, pyStr, readable, size } from "../text.mjs";
import { valueLines } from "./data.mjs";

// The file for an asset page. Two assets in one folder can have the same object name in
// different packages (/Game/A/Foo.Foo and /Game/A/Bar.Foo); the second is named after its
// package as well, so neither replaces the other.
function pageFile(docs, path) {
  const file = docs.fileFor("asset_values", path);
  if (!docs.files.has(file)) return file;
  const dot = path.indexOf(".");
  const packageLeaf = (dot < 0 ? path : path.slice(0, dot)).split("/").pop().replace(/[<>:"|?*\\]/g, "_");
  const base = `${file.slice(0, -3)}.${packageLeaf}`;
  let candidate = `${base}.md`;
  for (let n = 2; docs.files.has(candidate); n += 1) candidate = `${base}~${n}.md`;
  return candidate;
}

/** The asset values section: asset_values/<content path>.md. */
export function write(docs) {
  docs.lines("Assets/asset_values.jsonl", (item) => {
    const path = get(item, "path");
    const classPath = get(item, "class");
    const values = or(get(item, "values"), {});
    // An asset that already has a page (a data asset, a table) keeps that page.
    if (!path || docs.docOf.has(path) || !size(values)) return;
    const file = pageFile(docs, path);
    docs.docOf.set(path, file);
    const name = leaf(path);
    const ofClass = classPath ? `of class ${docs.link(classPath, file)}` : "of an unknown class";
    const body = [`# ${name}\n`, `Asset \`${pyStr(path)}\` ${ofClass}.\n`, "## Values\n", ...valueLines(values)];
    const names = keys(values).map(readable);
    const summary = classPath ? `asset of class ${leaf(classPath)}, ${names.length} values` : `asset of an unknown class, ${names.length} values`;
    docs.add(file, "asset_values", name, path, summary, body.join("\n"), names, { class: classPath ?? null });
  });
}
