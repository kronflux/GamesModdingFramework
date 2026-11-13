// Pages for assets that have no page of their own: every loaded asset the dumper wrote to
// Assets/asset_values.jsonl (sound classes, input actions, physical materials and so on),
// one page per asset that has values.

import { get, keys, leaf, or, pyStr, readable, size } from "../text.mjs";
import { valueLines } from "./data.mjs";

/** The asset values section: asset_values/<content path>.md. */
export function write(docs) {
  docs.lines("Assets/asset_values.jsonl", (item) => {
    const path = get(item, "path");
    const classPath = get(item, "class");
    const values = or(get(item, "values"), {});
    // An asset that already has a page (a data asset, a table) keeps that page.
    if (!path || docs.docOf.has(path) || !size(values)) return;
    const file = docs.fileFor("asset_values", path);
    docs.docOf.set(path, file);
    const name = leaf(path);
    const className = leaf(classPath);
    const body = [`# ${name}\n`, `Asset \`${pyStr(path)}\` of class ${docs.link(classPath, file)}.\n`, "## Values\n", ...valueLines(values)];
    const names = keys(values).map(readable);
    docs.add(file, "asset_values", name, path, `asset of class ${className}, ${names.length} values`, body.join("\n"), names,
      { class: classPath ?? null });
  });
}
