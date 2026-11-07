import crypto from "node:crypto";

const CONFIDENCE = new Set(["observed", "derived", "inferred"]);
const AUTHORITY = new Set([
  "shipped-artifact",
  "controlled-replay",
  "user-stated",
  "external",
  "analyst-inference",
]);
const SEVERITY = new Set(["low", "medium", "high", "critical"]);

function digest(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

export function evidence({ claim, confidence, authority, source, detail = {} } = {}) {
  if (typeof claim !== "string" || !claim.trim()) throw new Error("evidence claim must be a non-empty string");
  if (!CONFIDENCE.has(confidence)) {
    throw new Error(`evidence confidence must be observed, derived or inferred; got ${confidence}`);
  }
  if (!AUTHORITY.has(authority)) {
    throw new Error(
      `evidence authority must be shipped-artifact, controlled-replay, user-stated, external or analyst-inference; got ${authority}`,
    );
  }
  if (typeof source !== "string" || !source.trim()) throw new Error("evidence source must be a non-empty string");
  return { id: digest("ev", { claim, confidence, authority, source, detail }), claim, confidence, authority, source, detail };
}

export function unknown({ question, severity, nextProbe } = {}) {
  if (typeof question !== "string" || !question.trim()) throw new Error("unknown question must be a non-empty string");
  if (!SEVERITY.has(severity)) throw new Error(`unknown severity must be low, medium, high or critical; got ${severity}`);
  if (typeof nextProbe !== "string" || !nextProbe.trim()) throw new Error("unknown nextProbe must be a non-empty string");
  return { id: digest("unk", { question, severity, nextProbe }), question, severity, nextProbe };
}

export function mergeEvidence(existing = [], additions = []) {
  const byId = new Map();
  for (const record of [...existing, ...additions]) if (record && record.id) byId.set(record.id, record);
  return [...byId.values()];
}
