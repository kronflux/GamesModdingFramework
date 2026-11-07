// Importing this module registers every analyze.* operation through registerOperation.
// The operations array is also usable by a catalog loader, shaped like an engine
// module's operations list but without an engine module.

import entrypoints from "./entrypoints.mjs";
import classes from "./classes.mjs";
import objects from "./objects.mjs";
import references from "./references.mjs";
import assets from "./assets.mjs";
import strings from "./strings.mjs";

export const ANALYZE_OPERATION_IDS = Object.freeze([
  "analyze.entrypoints",
  "analyze.classes",
  "analyze.objects",
  "analyze.references",
  "analyze.assets",
  "analyze.strings",
]);

export const operations = [entrypoints, classes, objects, references, assets, strings].map(
  ({ descriptor, handler }) => ({ ...descriptor, handler }),
);

export default operations;
