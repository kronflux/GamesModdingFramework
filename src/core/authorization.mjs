import path from "node:path";
import { gateFor } from "./contracts.mjs";
import { readJson, writeJsonAtomic as writeJson } from "./fsutil.mjs";

const HARD = new Set(["destructive", "credentials", "piracy"]);

export { gateFor };

// An authorization for one effect also covers the effects it implies: a tool
// install is a download, so toolInstall covers network. Nothing covers gameWrite.
const IMPLIED = { toolInstall: ["network"] };

function covers(authorization, effect) {
  if (gateFor([authorization.effect]) !== "soft") return false;
  return authorization.effect === effect || (Object.hasOwn(IMPLIED, authorization.effect) && IMPLIED[authorization.effect].includes(effect));
}

// Every soft effect must have its own authorization. Returns the matched
// records and their distinct sources, or null when one effect is uncovered.
function findAuthorization(effects, plan, overrides) {
  const candidates = [
    ...(Array.isArray(plan?.authorizations) ? plan.authorizations : []),
    ...(Array.isArray(overrides) ? overrides : []),
  ].filter((entry) => entry && typeof entry.effect === "string" && typeof entry.source === "string");
  const gated = effects.filter((effect) => gateFor([effect]) === "soft");
  if (gated.length === 0) return null;
  const matched = gated.map((effect) => candidates.find((entry) => covers(entry, effect)) || null);
  if (matched.some((entry) => !entry)) return null;
  const sources = [...new Set(matched.map((entry) => entry.source))];
  return { effects: gated, source: sources.join("; "), records: matched };
}

export function missingAuthorizations(effects, plan, overrides) {
  const candidates = [
    ...(Array.isArray(plan?.authorizations) ? plan.authorizations : []),
    ...(Array.isArray(overrides) ? overrides : []),
  ].filter((entry) => entry && typeof entry.effect === "string" && typeof entry.source === "string");
  return effects.filter((effect) => gateFor([effect]) === "soft" && !candidates.some((entry) => covers(entry, effect)));
}

export function resolveAuthorization({ effects = [], plan = null, overrides = [] } = {}) {
  const gate = gateFor(effects);
  if (gate === "auto") return { allowed: true, gate, source: null, reason: "automatic" };
  if (gate === "hard") return { allowed: false, gate, source: null, reason: "hard gate requires explicit user approval" };
  const authorization = findAuthorization(effects, plan, overrides);
  if (authorization) return { allowed: true, gate, source: authorization.source, reason: "authorized" };
  const missing = missingAuthorizations(effects, plan, overrides);
  return { allowed: false, gate, source: null, reason: `authorization required for ${missing.join(", ")}`, missing };
}

// The workspace's active plan, when the context carries a workspace.
export function activePlan(context = {}) {
  const root = context.workspace?.root;
  return root ? readJson(path.join(root, "gmf.plan.json"), null) : null;
}

// The gate check for a list of effects against everything the context carries:
// an explicit plan, else the workspace's active plan, plus every override form.
export function authorizeEffects(effects, context = {}) {
  return resolveAuthorization({
    effects,
    plan: context.plan || activePlan(context),
    overrides: authorizationOverrides(context),
  });
}

// Every authorization the caller supplied, from any of the context forms:
// context.authorizations and context.overrides (arrays of { effect, source }),
// context.authorization (one record or an array), and the CLI or MCP flag
// --authorized, which may be one effect, a comma-separated list or an array.
export function authorizationOverrides(context = {}) {
  const overrides = [];
  const add = (entry) => {
    if (entry && typeof entry.effect === "string" && typeof entry.source === "string") overrides.push(entry);
  };
  for (const key of ["authorizations", "overrides"]) {
    if (Array.isArray(context[key])) context[key].forEach(add);
  }
  if (Array.isArray(context.authorization)) context.authorization.forEach(add);
  else add(context.authorization);
  // A flag authorization needs the user's words as its source; without them
  // it is not an authorization.
  const flag = context.flags?.authorized;
  const flagSource = typeof context.flags?.source === "string" ? context.flags.source.trim() : "";
  const list = Array.isArray(flag) ? flag : typeof flag === "string" ? flag.split(",") : [];
  if (flagSource) {
    for (const effect of list.map((value) => String(value).trim()).filter(Boolean)) {
      overrides.push({ effect, source: flagSource });
    }
  }
  return overrides;
}

// The gate check the executor runs before every handler, so an operation with a
// soft effect cannot run without a plan or user authorization even when its
// handler does not check.
export function authorizeOperation(descriptor, context = {}) {
  return authorizeEffects(descriptor.effects || [], context);
}

export function recordAuthorization(workspace, record) {
  const file = path.join(workspace.root, "gmf.plan.json");
  const plan = readJson(file, null) || {
    version: 1,
    goal: "",
    profile: "gmf.profile.json",
    steps: [],
    authorizations: [],
  };
  plan.authorizations = [
    ...(Array.isArray(plan.authorizations) ? plan.authorizations : []),
    { ...record, recordedAt: new Date().toISOString() },
  ];
  writeJson(file, plan);
  return plan;
}

export function assertHardGate(effect, source) {
  if (HARD.has(effect)) {
    const error = new Error(`GMF-E-POLICY-001: hard gate refused for ${effect} (${source || "no source"})`);
    error.code = "GMF-E-POLICY-001";
    throw error;
  }
  return true;
}
