// Every "gmf run <operation> --input key=value" in a skill must name an input
// the operation's schema declares, or an agent following the skill gets an
// input error on the first step.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCatalog } from "../src/core/catalog.mjs";
import { repoRoot } from "./helpers/paths.mjs";

const root = repoRoot;
const catalog = loadCatalog(root);
const operations = new Map(catalog.operations.map((operation) => [operation.id, operation]));

// An operation id followed by one or more --input pairs; a value is a quoted
// string, a placeholder such as <game folder> (spaces allowed) or one word.
const RUN_COMMAND = /gmf run ([a-z]+\.[a-z0-9_]+)((?:\s+--input\s+[A-Za-z0-9_]+=(?:"[^"]*"|<[^>]*>\S*|\S+))+)/g;

function skillFiles() {
  const dir = path.join(root, "skills");
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name, "SKILL.md"))
    .filter((file) => fs.existsSync(file));
}

test("every --input name in a skill is declared by its operation", () => {
  const problems = [];
  let checked = 0;
  for (const file of skillFiles()) {
    // Join wrapped lines so a command split across lines is read whole.
    const text = fs.readFileSync(file, "utf8").replace(/\n\s+/g, " ");
    for (const match of text.matchAll(RUN_COMMAND)) {
      checked += 1;
      const operation = operations.get(match[1]);
      if (!operation) {
        problems.push(`${path.relative(root, file)}: unknown operation ${match[1]}`);
        continue;
      }
      const declared = Object.keys(operation.inputs?.properties || {});
      for (const input of match[2].matchAll(/--input\s+([A-Za-z0-9_]+)=/g)) {
        if (!declared.includes(input[1])) {
          problems.push(`${path.relative(root, file)}: ${match[1]} has no input ${input[1]} (declared: ${declared.join(", ")})`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 0, "at least one skill command was checked");
});

test("a quoted value does not end the list of inputs the check reads", () => {
  const sample = 'gmf run game.detect --input query="<error text>" --input gameDir=<game folder>';
  const [match] = sample.matchAll(RUN_COMMAND);
  assert.equal(match[1], "game.detect");
  assert.deepEqual([...match[2].matchAll(/--input\s+([A-Za-z0-9_]+)=/g)].map((entry) => entry[1]), ["query", "gameDir"]);
});
