import { registerOperation } from "../../core/operations.mjs";
import { createAnalyzeOperation } from "./dump.mjs";

export const { descriptor, handler } = createAnalyzeOperation({
  id: "analyze.references",
  section: "references",
  title: "Analyze references",
  summary: "Find references between symbols, classes and objects in engine dump data.",
});

registerOperation(descriptor, handler);

export default { descriptor, handler };
