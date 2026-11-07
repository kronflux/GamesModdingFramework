import { registerOperation } from "../../core/operations.mjs";
import { createAnalyzeOperation } from "./dump.mjs";

export const { descriptor, handler } = createAnalyzeOperation({
  id: "analyze.entrypoints",
  section: "entrypoints",
  title: "Analyze entrypoints",
  summary: "Find entrypoints such as functions, methods and event handlers in engine dump data.",
});

registerOperation(descriptor, handler);

export default { descriptor, handler };
