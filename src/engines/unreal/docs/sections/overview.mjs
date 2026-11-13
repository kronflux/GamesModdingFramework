// overview.md: where a reader starts. The classes that run the game, by their role; the game
// mode of each map; and the classes that hold the most Blueprint logic.

import { get, getOr, leaf, or, pyStr, sortedBy, truthy } from "../text.mjs";

const NOTABLE = [
  ["Game modes", ["/Script/Engine.GameModeBase"]],
  ["Game states", ["/Script/Engine.GameStateBase"]],
  ["Game instances", ["/Script/Engine.GameInstance"]],
  ["Player controllers", ["/Script/Engine.PlayerController"]],
  ["Player states", ["/Script/Engine.PlayerState"]],
  ["Pawns and characters", ["/Script/Engine.Pawn"]],
  ["AI controllers", ["/Script/AIModule.AIController"]],
  ["HUDs", ["/Script/Engine.HUD"]],
  ["Cheat managers", ["/Script/Engine.CheatManager"]],
  ["Subsystems", ["/Script/Engine.Subsystem"]],
  ["Save games", ["/Script/Engine.SaveGame"]],
  ["Settings", ["/Script/Engine.GameUserSettings", "/Script/DeveloperSettings.DeveloperSettings"]],
  ["Function libraries", ["/Script/Engine.BlueprintFunctionLibrary"]],
];
const COUNTED = [
  ["actor components", "/Script/Engine.ActorComponent"], ["widgets", "/Script/UMG.UserWidget"],
  ["data assets", "/Script/Engine.DataAsset"], ["animation instances", "/Script/Engine.AnimInstance"],
  ["actors", "/Script/Engine.Actor"],
];

/** The overview section. */
export function write(docs) {
  const file = "overview.md";
  const game = docs.classes.filter((item) => docs.docOf.has(get(item, "path")));
  const chains = new Map();
  for (const item of game) chains.set(get(item, "path"), new Set(docs.chain(get(item, "path"))));
  const body = ["# Overview\n",
    "Where to start. The classes below are the game's own classes that fill the roles the engine defines; each links to its "
    + "page. Everything else is reached through the section indexes.\n"];
  for (const [title, ancestors] of NOTABLE) {
    const found = sortedBy(game.filter((item) => ancestors.some((a) => chains.get(get(item, "path")).has(a))),
      (item) => get(item, "name").toLowerCase());
    if (!found.length) continue;
    const lines = [];
    for (const item of found.slice(0, 60)) {
      const path = get(item, "path");
      const parents = docs.chain(path);
      const script = docs.scriptStats.get(path);
      lines.push(`- ${docs.link(path, file)}: parent ${parents.length ? leaf(parents[0]) : "none"}, `
        + `${getOr(item, "properties", []).length} properties, ${(docs.functionsOf.get(path) ?? []).length} functions`
        + (script ? `, [script](${script[0]})` : ""));
    }
    if (found.length > 60) lines.push(`- and ${found.length - 60} more`);
    body.push(`## ${title}\n\n` + lines.join("\n") + "\n");
  }
  const counts = COUNTED.map(([word, ancestor]) => `${game.filter((item) => chains.get(get(item, "path")).has(ancestor)).length} ${word}`);
  body.push(`## Other kinds\n\nOf the ${game.length} game classes: ` + counts.join(", ")
    + ". They are in [classes/](classes/_index.md), in folders that mirror the game's content paths.\n");

  const levels = getOr(or(docs.load("Levels/levels.json"), {}), "maps", []);
  if (truthy(levels)) {
    const rows = [];
    for (const entry of levels) {
      const name = getOr(entry, "folder", "").split("/").pop();
      const page = `levels/${name}/actors.md`;
      if (!docs.files.has(page)) {
        rows.push(`| \`${name}\` | | |`);
        continue;
      }
      const mode = docs.gameModeOf.get(`levels/${name}`);
      const shown = typeof mode === "string" && mode.startsWith("/") ? docs.link(mode, file) : "not set";
      rows.push(`| [${name}](${page}) | ${shown} | ${pyStr(getOr(entry, "actors", ""))} |`);
    }
    body.push("## Maps\n\nThe game mode is the one the map's world settings ask for; \"not set\" means the project default "
      + "applies.\n\n| Map | Game mode | Placed actors |\n|---|---|---|\n" + rows.join("\n") + "\n");
  }
  if (docs.files.has("world/runtime.md")) {
    body.push("## In use when the dump was taken\n\nThe game mode, game state, controller, pawn and HUD that were live are in "
      + "[world/runtime.md](world/runtime.md).\n");
  }
  const busiest = sortedBy([...docs.scriptStats], (entry) => -entry[1][1]).slice(0, 25);
  if (busiest.length) {
    body.push("## Classes with the most Blueprint logic\n\n" + busiest
      .map(([path, [script, statements, functions]]) => `- [${leaf(path)}](${script}): ${statements} statements in ${functions} functions`)
      .join("\n") + "\n");
  }
  docs.add(file, "overview", "Overview", null, "the classes that run the game by role, the game mode of each map, the busiest scripts",
    body.join("\n"), NOTABLE.map(([title]) => title));
}
