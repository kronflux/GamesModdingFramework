// The gameplay tags found in the dumped values, by root.

import { eachLine, pyStrip, sortedStrings } from "../text.mjs";

/** The tags section: names/gameplay_tags.md. */
export function write(docs) {
  if (!docs.exists("Names/gameplay_tags.txt")) return;
  const roots = new Map();
  eachLine(docs.path("Names/gameplay_tags.txt"), (line) => {
    const tag = pyStrip(line);
    if (tag && !tag.startsWith("#")) {
      const root = tag.split(".")[0];
      if (!roots.has(root)) roots.set(root, []);
      roots.get(root).push(tag);
    }
  });
  if (!roots.size) return;
  let total = 0;
  for (const list of roots.values()) total += list.length;
  const body = ["# Gameplay tags\n",
    `${total} gameplay tags found in the values this dump holds. This is not the game's full tag list: a tag that no dumped `
    + "value uses is missing.\n"];
  for (const root of sortedStrings(roots.keys())) {
    body.push(`## ${root}\n\n` + sortedStrings(new Set(roots.get(root))).map((tag) => `- \`${tag}\``).join("\n") + "\n");
  }
  docs.add("names/gameplay_tags.md", "gameplay_tags", "Gameplay tags", null, `${total} gameplay tags, by root`,
    body.join("\n"), sortedStrings(roots.keys()));
}
