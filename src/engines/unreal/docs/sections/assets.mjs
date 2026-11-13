// The asset registry as one page per content folder. An asset that has a document of its own,
// such as a Blueprint class or a data table, links to it.

import { get, getOr, leaf, mostCommon, or, sortedBy, sortedStrings } from "../text.mjs";
import { safe } from "./defaults.mjs";

/** The assets section. */
export function write(docs) {
  const registry = or(docs.load("Assets/asset_registry.json"), {});
  const documents = new Map(docs.docOf);
  for (const record of docs.records) if (!documents.has(record.id)) documents.set(record.id, record.file);
  const folders = new Map();
  for (const asset of getOr(registry, "assets", [])) {
    const pkg = or(get(asset, "package"), getOr(asset, "path", "").split(".")[0]);
    const folder = pkg.split("/").slice(0, -1).filter((part) => part).join("/");
    const key = folder || "root";
    if (!folders.has(key)) folders.set(key, []);
    folders.get(key).push(asset);
  }
  for (const folder of sortedStrings(folders.keys())) {
    const assets = sortedBy(folders.get(folder), (a) => getOr(a, "path", ""));
    const file = "assets/" + folder.split("/").map(safe).join("/") + ".md";
    const rows = [];
    for (const asset of assets) {
      const path = getOr(asset, "path", "");
      const target = documents.get(path);
      const name = leaf(path);
      const shown = target ? `[${name}](${docs.relative(target, file)})` : `\`${name}\``;
      rows.push(`| ${shown} | ${leaf(or(get(asset, "class"), ""))} | \`${path}\` |`);
    }
    const classes = new Map();
    for (const asset of assets) {
      const name = leaf(or(get(asset, "class"), ""));
      classes.set(name, (classes.get(name) ?? 0) + 1);
    }
    const body = `# Assets in /${folder}\n\n${assets.length} assets of the asset registry whose package is in this content folder. `
      + "The object path is what a mod loads or refers to.\n\n"
      + "| Asset | Class | Object path |\n|---|---|---|\n" + rows.join("\n") + "\n";
    docs.add(file, "assets", `Assets in /${folder}`, null,
      `${assets.length} assets: ` + mostCommon(classes, 4).map(([c, n]) => `${n} ${c}`).join(", "),
      body, assets.map((asset) => leaf(getOr(asset, "path", ""))));
  }
}
