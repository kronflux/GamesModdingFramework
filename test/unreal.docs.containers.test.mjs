// Container text pages: .ini settings, .locres localization and .uplugin/.uproject summaries.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLocres, writeLocres } from "../src/engines/unreal/docs/locres.mjs";
import { decodeText, parseIni } from "../src/engines/unreal/docs/ini.mjs";
import { containerPages } from "../src/engines/unreal/docs/sections/containers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-docs-containers-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function utf16WithBom(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

const NAMESPACES = [
  { name: "Menu", entries: [{ key: "Play", text: "Jouer à l'été" }, { key: "Quit", text: "終了\nnow" }] },
  { name: "", entries: [{ key: "Hello", text: "Hello | world" }] },
];

test("writeLocres then parseLocres round-trips for versions 1, 2 and 3", () => {
  for (const version of [1, 2, 3]) {
    const parsed = parseLocres(writeLocres(NAMESPACES, version));
    assert.equal(parsed.version, version);
    assert.deepEqual(parsed.namespaces, NAMESPACES, `version ${version}`);
  }
});

test("parseLocres reads the legacy version 0 and rejects an unknown version", () => {
  const legacy = parseLocres(writeLocres(NAMESPACES, 0));
  assert.equal(legacy.version, 0);
  assert.deepEqual(legacy.namespaces, NAMESPACES);
  const bad = Buffer.from(writeLocres(NAMESPACES, 3));
  bad[16] = 9;
  assert.throws(() => parseLocres(bad), /version 9/);
  assert.throws(() => parseLocres(writeLocres(NAMESPACES, 3).slice(0, 40)), Error);
});

test("parseIni keeps +Key= lines in order", () => {
  const parsed = parseIni(
    [
      "; comment",
      "[/Script/Engine.Engine]",
      "+ActiveGameNameRedirects=(OldGameName=\"A\",NewGameName=\"B\")",
      "+ActiveGameNameRedirects=(OldGameName=\"C\",NewGameName=\"D\")",
      "-Gone=1",
      ".Dot=2",
      "!Clear=",
      "",
      "# another comment",
      "[ConsoleVariables]",
      "r.Foo = 3",
      "r.Foo=4",
    ].join("\r\n"),
  );
  assert.deepEqual(parsed.sections.map((section) => section.name), ["/Script/Engine.Engine", "ConsoleVariables"]);
  assert.deepEqual(parsed.sections[0].entries, [
    { key: "ActiveGameNameRedirects", value: '(OldGameName="A",NewGameName="B")', op: "+" },
    { key: "ActiveGameNameRedirects", value: '(OldGameName="C",NewGameName="D")', op: "+" },
    { key: "Gone", value: "1", op: "-" },
    { key: "Dot", value: "2", op: "." },
    { key: "Clear", value: "", op: "!" },
  ]);
  assert.deepEqual(parsed.sections[1].entries, [
    { key: "r.Foo", value: "3", op: "" },
    { key: "r.Foo", value: "4", op: "" },
  ]);
});

test("decodeText handles UTF-16LE with BOM, UTF-8 with BOM and plain UTF-8", () => {
  assert.equal(decodeText(utf16WithBom("[A]\nk=é")), "[A]\nk=é");
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("k=é")])), "k=é");
  assert.equal(decodeText(Buffer.from("k=é")), "k=é");
});

test("containerPages turns ini, locres and uplugin files into pages (AC-9)", () => {
  const textDir = path.join(root, "text");
  write(path.join(textDir, "Game", "Engine", "Config", "Base.ini"), "[ConsoleVariables]\nr.Foo=1\n+Arr=(A|B)\n");
  write(
    path.join(textDir, "Game", "StormEscape", "Config", "DefaultGame.ini"),
    utf16WithBom("[/Script/Engine.GameSession]\r\n+Names=One\r\n+Names=Two\r\nMax=4\r\n"),
  );
  // Same path in a later pak wins.
  write(path.join(textDir, "Zeta", "Engine", "Config", "Base.ini"), "[ConsoleVariables]\nr.Foo=2\n");
  write(path.join(textDir, "Game", "Engine", "Content", "Localization", "Engine", "en", "Engine.locres"), writeLocres(NAMESPACES, 3));
  write(path.join(textDir, "Game", "Engine", "Content", "Localization", "Engine", "fr", "Engine.locres"), writeLocres([{ name: "Menu", entries: [{ key: "Play", text: "Jouer" }] }], 2));
  write(path.join(textDir, "Zeta", "Engine", "Content", "Localization", "Engine", "en", "More.locres"), writeLocres([{ name: "Menu", entries: [{ key: "Extra", text: "More" }] }], 3));
  write(
    path.join(textDir, "Game", "Engine", "Plugins", "2D", "Paper2D", "Paper2D.uplugin"),
    JSON.stringify({ FriendlyName: "Paper 2D", VersionName: "1.0", Category: "2D", EnabledByDefault: true, Description: "2D | sprites", Modules: [{ Name: "Paper2D" }, { Name: "Paper2DEditor" }] }),
  );
  write(
    path.join(textDir, "Game", "StormEscape", "Plugins", "Fun", "Fun.uplugin"),
    JSON.stringify({ VersionName: "2", Category: "Gameplay", EnabledByDefault: false, Modules: [{ Name: "Fun" }] }),
  );
  write(
    path.join(textDir, "Game", "StormEscape", "StormEscape.uproject"),
    JSON.stringify({ EngineAssociation: "5.6", Plugins: [{ Name: "Fun", Enabled: true }, { Name: "Off", Enabled: false }] }),
  );
  write(path.join(textDir, "Game", "Engine", "Broken.uplugin"), "{ not json");

  const before = fs.readdirSync(textDir, { recursive: true }).sort();
  const result = containerPages(textDir);
  assert.deepEqual(fs.readdirSync(textDir, { recursive: true }).sort(), before, "writes nothing");
  assert.deepEqual(result.counts, { ini: 3, locres: 3, uplugin: 3 });
  const byFile = new Map(result.pages.map((page) => [page.file, page]));

  const base = byFile.get("settings/Engine__Config__Base.md");
  assert.ok(base, [...byFile.keys()].join(", "));
  assert.equal(base.kind, "settings");
  assert.match(base.text, /^---\nkind: "settings"\nname: "Engine__Config__Base"\nsource: "Engine\/Config\/Base\.ini"\n---\n\n# /);
  assert.match(base.text, /Zeta/);
  assert.match(base.text, /\| r\.Foo \| {2}\| 2 \|/);
  assert.doesNotMatch(base.text, /\| 1 \|/);

  const game = byFile.get("settings/StormEscape__Config__DefaultGame.md");
  assert.match(game.text, /## \[\/Script\/Engine\.GameSession\]/);
  assert.match(game.text, /\| Key \| Op \| Value \|/);
  const names = game.text.split("\n").filter((line) => line.startsWith("| Names "));
  assert.deepEqual(names, ["| Names | + | One |", "| Names | + | Two |"]);

  const menu = byFile.get("localization/en/Menu.md");
  assert.ok(menu, [...byFile.keys()].join(", "));
  assert.match(menu.text, /\| Play \| Jouer à l'été \|/);
  assert.match(menu.text, /\| Quit \| 終了\\nnow \|/);
  assert.match(menu.text, /\| Extra \| More \|/, "entries of one culture and namespace are merged");
  assert.match(byFile.get("localization/en/_default.md").text, /\| Hello \| Hello \\\| world \|/);
  assert.match(byFile.get("localization/fr/Menu.md").text, /\| Play \| Jouer \|/);

  const plugins = byFile.get("plugins.md");
  assert.ok(plugins);
  assert.match(plugins.text, /EngineAssociation/);
  assert.match(plugins.text, /5\.6/);
  assert.match(plugins.text, /Paper 2D/);
  assert.match(plugins.text, /Paper2D, Paper2DEditor/);
  assert.match(plugins.text, /2D \\\| sprites/);
  assert.ok(plugins.text.indexOf("Fun.uplugin") < plugins.text.indexOf("Paper2D.uplugin"), "game plugins are listed first");
  assert.match(plugins.text, /Broken\.uplugin/, "an unreadable plugin file is still listed");

  for (const page of result.pages) {
    assert.match(page.text, /^---\nkind: ".+"\nname: ".+"\nsource: ".+"\n---\n\n# /, page.file);
    assert.ok(page.text.endsWith("\n"));
  }
});

test("containerPages on an empty folder returns no pages", () => {
  const dir = path.join(root, "empty");
  fs.mkdirSync(dir);
  const empty = containerPages(dir);
  assert.deepEqual(empty.pages, []);
  assert.deepEqual(empty.counts, { ini: 0, locres: 0, uplugin: 0 });
});
