// Splitting of large documents (ported from OmniDumper tools/tests/test_make_docs.py, SplitTests).

import test from "node:test";
import assert from "node:assert/strict";
import { splitDocument } from "../src/engines/unreal/docs/split.mjs";

const FRONT = '---\nkind: "script"\ntitle: "Big"\n---\n\n';
const count = (text, needle) => text.split(needle).length - 1;

function bigDocument() {
  let code = "";
  let rows = "";
  for (let n = 0; n < 40; n += 1) {
    code += `0000: line ${n}\n`;
    rows += `| k${n} | v${n} |\n`;
  }
  return `${FRONT}# Big\n\nIntro.\n\n## A\n\n\`\`\`text\n${code}\`\`\`\n\n## B\n\n| K | V |\n|---|---|\n${rows}\n## C\n\nshort\n`;
}

test("a long document is cut into parts, and code blocks and tables stay whole", () => {
  const parts = splitDocument(bigDocument(), "x/Big.script.md", 700);
  assert.ok(parts.length > 2);
  assert.deepEqual(parts.slice(0, 2).map((part) => part.file), ["x/Big.script.md", "x/Big.script.part2.md"]);
  for (const { file, text } of parts) {
    assert.ok(Buffer.byteLength(text, "utf8") <= 700, file);
    assert.equal(count(text, "```") % 2, 0, `${file} leaves a code block open`);
    assert.ok(text.startsWith("---\n"), file);
    if (text.includes("| k")) assert.ok(text.includes("| K | V |\n|---|---|\n"), `${file} continues the table without its header`);
  }
  const joined = parts.map((part) => part.text).join("\n");
  for (let n = 0; n < 40; n += 1) {
    assert.equal(count(joined, `0000: line ${n}\n`), 1);
    assert.equal(count(joined, `| k${n} | v${n} |\n`), 1);
  }
  assert.equal(count(joined, "\nshort\n"), 1);
  assert.ok(parts[0].text.includes(`split into ${parts.length} parts`));
  assert.ok(parts[0].text.includes("[part 2](Big.script.part2.md)"));
  assert.ok(parts[1].text.includes(`title: "Big (part 2 of ${parts.length})"`));
  assert.ok(parts[1].text.includes("[Big](Big.script.md)"));
  assert.ok(joined.includes("## A (continued)"));
});

test("a document under the limit is left alone", () => {
  const text = `${FRONT}# Small\n\nText.\n`;
  assert.deepEqual(splitDocument(text, "Small.md", 700), [{ file: "Small.md", text }]);
});

test("one section larger than the limit is cut between lines, and with linkNext every part links to the next", () => {
  let lines = "";
  for (let n = 0; n < 200; n += 1) lines += `- entry number ${n} of one very long section\n`;
  const text = `${FRONT}# Big\n\n## Only\n\n${lines}`;
  const parts = splitDocument(text, "Big.md", 1200, { linkNext: true });
  assert.ok(parts.length > 3);
  const joined = parts.map((part) => part.text).join("\n");
  for (let n = 0; n < 200; n += 1) assert.equal(count(joined, `- entry number ${n} of`), 1, `entry ${n}`);
  parts.forEach(({ file, text: part }, index) => {
    assert.ok(Buffer.byteLength(part, "utf8") <= 1200, file);
    const last = index === parts.length - 1;
    const nextLink = `Continued in [part ${index + 2}](Big.part${index + 2}.md).`;
    assert.equal(part.includes(nextLink), !last, `${file} ${last ? "has" : "lacks"} a link to the next part`);
    if (index > 0) assert.ok(part.includes("## Only (continued)"), file);
  });
  const plain = splitDocument(text, "Big.md", 1200);
  assert.equal(plain.some((part) => part.text.includes("Continued in")), false, "off by default");
});
