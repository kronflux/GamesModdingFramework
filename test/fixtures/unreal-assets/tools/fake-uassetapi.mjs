// Synthetic UAssetAPI stand-in for the asset inspect and replace tests. Writes placeholder files only.
import fs from "node:fs";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const command = args[0];
if (command === "inspect") {
  console.log(JSON.stringify({ assetClass: "Blueprint", assetName: "BP_Foo", engineVersion: "5.3" }));
  process.exit(0);
}
if (command === "replace") {
  const target = valueFor("--asset");
  const input = valueFor("--input");
  if (!target) {
    console.error("fake-uassetapi: missing --asset");
    process.exit(2);
  }
  fs.writeFileSync(target, input ? fs.readFileSync(input) : "synthetic in-place replacement\n");
  console.log(JSON.stringify({ ok: true, asset: target }));
  process.exit(0);
}
console.error(`fake-uassetapi: unknown command ${command}`);
process.exit(2);
