import { getHandler, registerOperation } from "../../core/operations.mjs";
import { searchKnowledge } from "../../core/knowledge.mjs";
import { evidence } from "../../core/evidence.mjs";

// A note's confidence as an evidence confidence: observed, derived and inferred
// pass through, verified is the strongest evidence level (observed), and
// anything else is inferred.
function evidenceConfidence(value) {
  if (value === "verified") return "observed";
  return ["observed", "derived", "inferred"].includes(value) ? value : "inferred";
}

export const knowledgeSearchOperation = {
  id: "knowledge.search",
  title: "Search the knowledge base",
  summary:
    "Search knowledge notes by ID, title, tags and body text; returns metadata, confidence and the path, not the body.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      query: { type: "string" },
      engine: { type: "string" },
      tag: { type: "string" },
    },
    required: ["query"],
  },
  outputs: {
    type: "object",
    properties: {
      entries: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: ["knowledge/core/catalog.md", "knowledge/core/anti-cheat.md"],
  handler: async (inputs, context = {}) => {
    const entries = searchKnowledge(inputs.query, {
      root: context.root || process.cwd(),
      engine: inputs.engine || null,
      tag: inputs.tag || null,
      entries: context.knowledge || null,
    });
    return {
      data: { entries },
      evidence: entries.map((entry) =>
        evidence({
          claim: `Knowledge note ${entry.id} matched the query`,
          confidence: evidenceConfidence(entry.confidence),
          authority: "external",
          source: entry.path,
          detail: { id: entry.id, confidence: entry.confidence },
        }),
      ),
    };
  },
};

export default knowledgeSearchOperation;

if (!getHandler(knowledgeSearchOperation.id)) {
  registerOperation(knowledgeSearchOperation, knowledgeSearchOperation.handler);
}
