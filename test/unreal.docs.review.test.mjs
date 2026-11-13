// Cases found in review of the docs builder additions: split tables, game text that looks like
// a link, and pages whose file names collide.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDocs } from "../src/engines/unreal/docs/build.mjs";
import { containerPages } from "../src/engines/unreal/docs/sections/containers.mjs";
import { writeLocres } from "../src/engines/unreal/docs/locres.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" || content instanceof Uint8Array ? content : JSON.stringify(content));
}

function makeRun(root, assetLines = []) {
  const run = path.join(root, "run");
  write(path.join(run, "manifest.json"), { schema: "gmfdumper.manifest/1", game: "Demo", steps: [] });
  if (assetLines.length) {
    const header = JSON.stringify({ schema: "gmfdumper.values/1", kind: "asset values" });
    write(path.join(run, "Assets", "asset_values.jsonl"), [header, ...assetLines.map((line) => JSON.stringify(line)), ""].join("\n"));
  }
  return run;
}

const locres = (namespaces) => writeLocres(namespaces.map(([name, entries]) => ({ name, entries: entries.map(([key, text]) => ({ key, text })) })), 3);

test("a split settings page and a split localization page keep the table header in every part", async (t) => {
  const root = tempDir(t, "gmf-docs-review-");
  const textDir = path.join(root, "text");
  let ini = "[Sec]\n";
  const entries = [];
  for (let n = 0; n < 3000; n += 1) {
    ini += `Key${n}=Value number ${n} with some padding to make the page large\n`;
    entries.push([`Key${n}`, `Text number ${n} with some padding to make the page large`]);
  }
  write(path.join(textDir, "P", "Demo", "Config", "DefaultBig.ini"), ini);
  write(path.join(textDir, "P", "Demo", "Content", "Localization", "Game", "en", "Game.locres"), locres([["Big", entries]]));
  const out = path.join(root, "out");
  const built = await buildDocs(makeRun(root), out, { textDir });
  assert.deepEqual(built.brokenLinks, []);
  for (const [folder, stem, header] of [
    [path.join(out, "settings"), "Demo__Config__DefaultBig", "| Key | Op | Value |\n|---|---|---|\n"],
    [path.join(out, "localization", "en"), "Big", "| Key | Text |\n|---|---|\n"],
  ]) {
    const parts = fs.readdirSync(folder).filter((name) => name.startsWith(stem) && name.endsWith(".md"));
    assert.ok(parts.length > 2, `${stem} is split`);
    for (const name of parts) {
      const text = fs.readFileSync(path.join(folder, name), "utf8");
      if (/^\| Key\d/m.test(text)) assert.ok(text.includes(header), `${name} has rows without the table header`);
    }
  }
});

test("game text that looks like a markdown link is not a link and does not fail the build", async (t) => {
  const root = tempDir(t, "gmf-docs-review-");
  const textDir = path.join(root, "text");
  write(path.join(textDir, "P", "Demo", "Config", "DefaultGame.ini"), "[S]\nHelp=[x](nowhere.md)\nPath=a\\|b\n");
  write(path.join(textDir, "P", "Demo", "Content", "Localization", "Game", "en", "Game.locres"), locres([["Lnk", [["K", "see [here](nothing.md) now"]]]]));
  const run = makeRun(root, [{ path: "/Game/A/Note.Note", class: "/Script/Demo.Note", values: { Text: "read [this](gone.md)", Deep: { More: "[a](b.md)" } } }]);
  const built = await buildDocs(run, path.join(root, "out"), { textDir });
  assert.deepEqual(built.brokenLinks, []);
  const settings = fs.readFileSync(path.join(root, "out", "settings", "Demo__Config__DefaultGame.md"), "utf8");
  assert.ok(settings.includes("| Path |  | a\\\\\\|b |"), "a backslash before a pipe is escaped too, so the row keeps three cells");
});

test("localization pages that differ only in replaced characters or case get their own files", (t) => {
  const root = tempDir(t, "gmf-docs-review-");
  const loc = (culture) => path.join(root, "P", "Demo", "Content", "Localization", "Game", culture, "Game.locres");
  write(loc("en"), locres([["A B", [["k", "from A B"]]], ["A_B", [["k", "from A_B"]]], ["Menu", [["k", "upper"]]], ["menu", [["k", "lower"]]],
    ["", [["k", "from empty"]]], ["_default", [["k", "from _default"]]]]));
  write(loc("en US"), locres([["N", [["k", "from en US"]]]]));
  write(loc("en_US"), locres([["N", [["k", "from en_US"]]]]));
  const { pages } = containerPages(root);
  const local = pages.filter((page) => page.kind === "localization");
  const files = local.map((page) => page.file.toLowerCase());
  assert.equal(new Set(files).size, files.length, `every page has its own file: ${files.join(", ")}`);
  assert.equal(local.length, 8);
  for (const text of ["from A B", "from A_B", "upper", "lower", "from empty", "from _default", "from en US", "from en_US"]) {
    assert.equal(local.filter((page) => page.text.includes(text)).length, 1, text);
  }
});

test("two assets that would share a page file each get a page, and an asset without a class is described", async (t) => {
  const root = tempDir(t, "gmf-docs-review-");
  const run = makeRun(root, [
    { path: "/Game/A/Foo.Foo", class: "/Script/Demo.Thing", values: { V: 1 } },
    { path: "/Game/A/Bar.Foo", class: "/Script/Demo.Thing", values: { V: 2 } },
    { path: "/Game/A/Baz.Baz", values: { V: 3 } },
  ]);
  const out = path.join(root, "out");
  const built = await buildDocs(run, out);
  assert.equal(built.sections.find((s) => s.name === "asset_values").pages, 3);
  const folder = path.join(out, "asset_values", "Game", "A");
  assert.deepEqual(fs.readdirSync(folder).filter((name) => name !== "_index.md").sort(), ["Baz.md", "Foo.Bar.md", "Foo.md"]);
  assert.match(fs.readFileSync(path.join(folder, "Foo.md"), "utf8"), /\*\*V:\*\* `1`/);
  assert.match(fs.readFileSync(path.join(folder, "Foo.Bar.md"), "utf8"), /\*\*V:\*\* `2`/);
  assert.match(fs.readFileSync(path.join(folder, "Baz.md"), "utf8"), /of an unknown class/);
  const ids = fs.readFileSync(path.join(out, "index.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).file);
  assert.equal(new Set(ids).size, ids.length, "no two index records share a file");
});
