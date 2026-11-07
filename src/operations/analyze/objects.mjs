import { registerOperation } from "../../core/operations.mjs";
import { createAnalyzeOperation } from "./dump.mjs";

export const { descriptor, handler } = createAnalyzeOperation({
  id: "analyze.objects",
  section: "objects",
  title: "Analyze objects",
  summary: "Find object instances and their classes in engine dump data.",
});

registerOperation(descriptor, handler);

export default { descriptor, handler };
