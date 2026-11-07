import { registerOperation } from "../../core/operations.mjs";
import { createAnalyzeOperation } from "./dump.mjs";

export const { descriptor, handler } = createAnalyzeOperation({
  id: "analyze.classes",
  section: "classes",
  title: "Analyze classes",
  summary: "Find classes and their member metadata in engine dump data.",
});

registerOperation(descriptor, handler);

export default { descriptor, handler };
