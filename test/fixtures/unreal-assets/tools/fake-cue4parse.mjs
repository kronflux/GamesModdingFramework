// Synthetic CUE4Parse stand-in for the asset extraction test. Writes placeholder files only.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const output = valueFor("--output");
if (!output) {
  console.error("fake-cue4parse: missing --output");
  process.exit(2);
}
fs.mkdirSync(path.join(output, "Textures"), { recursive: true });
fs.writeFileSync(path.join(output, "Textures", "T_Foo.uasset"), "synthetic extracted asset\n");
fs.writeFileSync(
  path.join(output, "extract-report.json"),
  `${JSON.stringify({ filter: valueFor("--filter"), extracted: 1 }, null, 2)}\n`,
);
console.log(JSON.stringify({ ok: true, extracted: 1 }));
