// World pages: the level of the main run, and one sub folder per map the map tour visited.

import { get, getOr, md, or, pyStr } from "../text.mjs";
import { writeLevel } from "./levels.mjs";

/** The world section. */
export function write(docs) {
  writeLevel(docs, "World", "world", get(docs.manifest, "map"));
  const tour = or(docs.load("World/map_tour.json"), {});
  const rows = [];
  const maps = getOr(tour, "maps", []);
  for (const entry of maps) {
    const name = getOr(entry, "folder", "").split("/").pop();
    const target = `world/${name}/actors.md`;
    if (get(entry, "status") === "ok" && name) writeLevel(docs, get(entry, "folder"), `world/${name}`, get(entry, "map"));
    const shown = docs.files.has(target) ? `[${name}](${name}/actors.md)` : `\`${name}\``;
    rows.push(`| ${shown} | \`${pyStr(get(entry, "map"))}\` | ${pyStr(get(entry, "status"))} | ${md(or(get(entry, "error"), ""))} |`);
  }
  if (rows.length) {
    const body = "# Map tour\n\nThe maps opened after the main run, each without a game session, and what became of each.\n\n"
      + "| Level | Map | Result | Note |\n|---|---|---|---|\n" + rows.join("\n") + "\n";
    docs.add("world/map_tour.md", "map_tour", "Map tour", null, `${rows.length} maps visited after the main run`, body,
      maps.map((e) => getOr(e, "map", "")));
  }
}
