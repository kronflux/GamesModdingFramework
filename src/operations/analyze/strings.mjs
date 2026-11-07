import { registerOperation } from "../../core/operations.mjs";
import { createAnalyzeOperation } from "./dump.mjs";

export const { descriptor, handler } = createAnalyzeOperation({
  id: "analyze.strings",
  section: "strings",
  title: "Analyze strings",
  summary: "Find strings recorded in engine dump data without returning file contents.",
});

registerOperation(descriptor, handler);

export default { descriptor, handler };
