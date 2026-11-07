import { registerOperation } from "../../core/operations.mjs";
import { createAnalyzeOperation } from "./dump.mjs";

export const { descriptor, handler } = createAnalyzeOperation({
  id: "analyze.assets",
  section: "assets",
  title: "Analyze assets",
  summary: "Find assets recorded in engine dump data.",
});

registerOperation(descriptor, handler);

export default { descriptor, handler };
