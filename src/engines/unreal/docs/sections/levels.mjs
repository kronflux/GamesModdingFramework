// Level pages: one sub folder per map that was read as data, with its runtime context, its
// actors and the values of its placed actors, and a page that lists the maps.

import { get, getOr, leaf, md, mostCommon, or, pyFixed, pyStr, truthy } from "../text.mjs";
import { writeLevelValues } from "./defaults.mjs";

/** The runtime and actor pages of one level, read from the run folder `source`. */
export function writeLevel(docs, source, section, mapPath, asData = false) {
  const tail = pyStr(or(mapPath, "")).split("/").pop();
  const name = tail.split(".").pop();
  const runtime = docs.load(`${source}/runtime.json`);
  if (truthy(runtime)) {
    const file = `${section}/runtime.md`;
    const objects = getOr(runtime, "objects", []);
    const rows = objects.filter((o) => truthy(get(o, "classes")))
      .map((o) => `| ${pyStr(get(o, "role"))} | ${docs.link(get(o, "classes")[0], file)} | \`${md(get(o, "path"))}\` |`).join("\n");
    const body = "# Runtime context\n\nThe objects a mod usually starts from, as they were when the dump was taken"
      + ` on map \`${pyStr(mapPath)}\`.\n\n| Role | Class | Object |\n|---|---|---|\n${rows}\n`;
    docs.add(file, "runtime", `Runtime context of ${name}`, null,
      "game mode, game state, controller, pawn and HUD in use", body, objects.map((o) => get(o, "role")));
  }
  const actorsData = docs.load(`${source}/actors.json`);
  if (truthy(actorsData) && truthy(get(actorsData, "actors"))) {
    const actors = get(actorsData, "actors");
    const file = `${section}/actors.md`;
    const byClass = new Map();
    for (const actor of actors) {
      const classPath = get(actor, "class");
      byClass.set(classPath, (byClass.get(classPath) ?? 0) + 1);
    }
    const rows = mostCommon(byClass).map(([c, n]) => `| ${docs.link(c, file)} | ${n} |`).join("\n");
    const listing = actors.slice(0, 2000).map((a) => {
      const location = get(a, "location");
      return `| \`${md(leaf(get(a, "path")))}\` | ${docs.link(get(a, "class"), file)} | `
        + `${truthy(location) ? location.map((v) => pyFixed(v, 1)).join(", ") : ""} | ${getOr(a, "components", []).length} |`;
    }).join("\n");
    let more = actors.length > 2000 ? `\nThe first 2000 of ${actors.length} actors are listed; the rest are in the dump.\n` : "";
    more += writeLevelValues(docs, source, section, name);
    const where = asData ? `Map \`${pyStr(mapPath)}\`` : `World \`${pyStr(get(actorsData, "player_world"))}\``;
    const body = `# Actors of ${name}\n\n${where}, ${actors.length} actors.\n\n`
      + `## By class\n\n| Class | Count |\n|---|---|\n${rows}\n\n`
      + `## Actors\n\n| Actor | Class | Location | Components |\n|---|---|---|---|\n${listing}\n${more}`;
    docs.add(file, "actors", `Actors of ${name}`, null, `${actors.length} actors of the level`, body, [...byClass.keys()].map(leaf));
  }
}

/** The levels section: one sub folder per map that was read as data, and a page that lists them. */
export function write(docs) {
  const levels = or(docs.load("Levels/levels.json"), {});
  const rows = [];
  const maps = getOr(levels, "maps", []);
  for (const entry of maps) {
    const name = getOr(entry, "folder", "").split("/").pop();
    const target = `levels/${name}/actors.md`;
    if (get(entry, "status") === "ok" && name) writeLevel(docs, get(entry, "folder"), `levels/${name}`, get(entry, "map"), true);
    const shown = docs.files.has(target) ? `[${name}](${name}/actors.md)` : `\`${name}\``;
    const actors = get(entry, "actors");
    rows.push(`| ${shown} | \`${pyStr(get(entry, "map"))}\` | ${pyStr(get(entry, "status"))} | ${actors === undefined || actors === null ? "" : pyStr(actors)} | `
      + `${md(or(get(entry, "error"), ""))} |`);
  }
  if (rows.length) {
    const body = "# Levels\n\nEvery map of the game, read as data without travelling to it. A page shows the level as built: "
      + "the actors saved in the map, not the ones a running match spawns.\n\n"
      + "| Level | Map | Result | Actors | Note |\n|---|---|---|---|---|\n" + rows.join("\n") + "\n";
    docs.add("levels/levels.md", "levels", "Levels", null, `${rows.length} maps read as data`, body, maps.map((e) => getOr(e, "map", "")));
  }
}
