// Schema constants and validators for the catalog, profile and plan.
// These are the contracts other modules and tests depend on.

export const CATALOG_VERSION = 1;
export const PROFILE_VERSION = 1;
export const PLAN_VERSION = 1;

export const EFFECTS = [
  "read",
  "workspaceWrite",
  "gameWrite",
  "toolInstall",
  "network",
  "launchGame",
  "execute",
  "destructive",
  "antiCheat",
  "credentials",
  "piracy",
];

const HARD_EFFECTS = new Set(["destructive", "credentials", "piracy"]);
const SOFT_EFFECTS = new Set(["gameWrite", "toolInstall", "network", "launchGame", "antiCheat", "execute"]);
const GATES = new Set(["auto", "soft", "hard"]);
const CONFIDENCE = new Set(["observed", "derived", "inferred"]);

// Template kinds: a scaffold is a whole mod, a feature or helper is a file set
// copied into a scaffold, a payload is deployed beside a loader (the dump helper).
export const TEMPLATE_KINDS = ["scaffold", "feature", "helper", "payload"];

// Skill frontmatter fields. knowledge lists note IDs the skill routes to and is
// validated like operations.
export const SKILL_FRONTMATTER = ["name", "description", "operations", "knowledge"];

// Profile engine hint: a family marker for a game that is not Unity or Unreal.
// { family, confidence, evidence: [{ path, claim }] }
export const PROFILE_ENGINE_HINT = Object.freeze({ family: "string", confidence: "observed|derived|inferred", evidence: "array" });
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

export function gateFor(effects = []) {
  if (!Array.isArray(effects)) return "auto";
  if (effects.some((effect) => HARD_EFFECTS.has(effect))) return "hard";
  if (effects.some((effect) => SOFT_EFFECTS.has(effect))) return "soft";
  return "auto";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function push(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validateOperation(op) {
  const errors = [];
  if (!isObject(op)) return { ok: false, errors: ["operation must be an object"] };

  push(errors, nonEmptyString(op.id), "id must be a non-empty string");
  push(errors, nonEmptyString(op.title), "title must be a non-empty string");
  push(errors, nonEmptyString(op.summary), "summary must be a non-empty string");
  push(errors, nonEmptyString(op.engine), "engine must be a non-empty string");
  if (nonEmptyString(op.id)) push(errors, ID_RE.test(op.id), "id must be namespaced, for example unity.decompile");
  push(errors, isObject(op.inputs) && op.inputs.type === "object", "inputs must be a JSON-schema object");
  push(errors, isObject(op.outputs) && op.outputs.type === "object", "outputs must be a JSON-schema object");

  if (!Array.isArray(op.effects) || op.effects.length === 0) {
    errors.push("effects must be a non-empty array");
  } else {
    for (const effect of op.effects) push(errors, EFFECTS.includes(effect), `unknown effect: ${effect}`);
  }

  push(errors, Array.isArray(op.requires), "requires must be an array");

  if (!Array.isArray(op.gates) || op.gates.length === 0) {
    errors.push("gates must be a non-empty array");
  } else {
    for (const gate of op.gates) push(errors, GATES.has(gate), `unknown gate: ${gate}`);
    if (Array.isArray(op.effects)) {
      const expected = gateFor(op.effects);
      push(errors, op.gates.includes(expected), `gates must include ${expected} for the declared effects`);
    }
  }

  if (op.skill !== undefined) push(errors, nonEmptyString(op.skill), "skill must be a non-empty string");
  if (op.docs !== undefined) push(errors, Array.isArray(op.docs), "docs must be an array");
  return { ok: errors.length === 0, errors };
}

export function validateTool(tool) {
  const errors = [];
  if (!isObject(tool)) return { ok: false, errors: ["tool must be an object"] };
  for (const key of ["id", "name", "purpose", "engine", "license"]) {
    push(errors, nonEmptyString(tool[key]), `${key} must be a non-empty string`);
  }
  push(errors, isObject(tool.source), "source must be an object");
  push(errors, nonEmptyString(tool.versionPolicy), "versionPolicy must be a non-empty string");
  if (!Array.isArray(tool.effects) || tool.effects.length === 0) {
    errors.push("effects must be a non-empty array");
  } else {
    for (const effect of tool.effects) push(errors, EFFECTS.includes(effect), `unknown effect: ${effect}`);
  }
  push(errors, Array.isArray(tool.capabilities), "capabilities must be an array");
  return { ok: errors.length === 0, errors };
}

export function validateKnowledge(entry) {
  const errors = [];
  if (!isObject(entry)) return { ok: false, errors: ["knowledge entry must be an object"] };
  for (const key of ["id", "title", "engine", "summary", "path"]) {
    push(errors, nonEmptyString(entry[key]), `${key} must be a non-empty string`);
  }
  push(errors, Array.isArray(entry.tags), "tags must be an array");
  push(errors, ["verified", "observed", "inferred"].includes(entry.confidence), "confidence must be verified, observed or inferred");
  push(errors, Array.isArray(entry.sources), "sources must be an array");
  return { ok: errors.length === 0, errors };
}

export function validateEngineHint(hint) {
  const errors = [];
  if (!isObject(hint)) return { ok: false, errors: ["hint must be an object"] };
  push(errors, nonEmptyString(hint.family), "family must be a non-empty string");
  push(errors, CONFIDENCE.has(hint.confidence), "confidence must be observed, derived or inferred");
  push(errors, Array.isArray(hint.evidence), "evidence must be an array");
  if (Array.isArray(hint.evidence)) {
    for (const item of hint.evidence) push(errors, isObject(item) && nonEmptyString(item.path), "evidence items need a path");
  }
  return { ok: errors.length === 0, errors };
}

export function validateProfile(profile) {
  const errors = [];
  if (!isObject(profile)) return { ok: false, errors: ["profile must be an object"] };
  push(errors, profile.version === PROFILE_VERSION, "version must be 1");
  for (const key of ["game", "engine", "runtime", "loader", "markers", "paths"]) {
    push(errors, isObject(profile[key]), `${key} must be an object`);
  }
  for (const key of ["tools", "capabilities", "unknowns", "evidence"]) {
    push(errors, Array.isArray(profile[key]), `${key} must be an array`);
  }
  if (isObject(profile.engine)) {
    push(errors, nonEmptyString(profile.engine.id), "engine.id must be a non-empty string");
    if (profile.engine.hints !== undefined) {
      push(errors, Array.isArray(profile.engine.hints), "engine.hints must be an array");
      for (const hint of Array.isArray(profile.engine.hints) ? profile.engine.hints : []) {
        for (const error of validateEngineHint(hint).errors) errors.push(`engine.hints: ${error}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validatePlan(plan) {
  const errors = [];
  if (!isObject(plan)) return { ok: false, errors: ["plan must be an object"] };
  push(errors, plan.version === PLAN_VERSION, "version must be 1");
  push(errors, nonEmptyString(plan.goal), "goal must be a non-empty string");
  push(errors, nonEmptyString(plan.profile), "profile must be a non-empty string");

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    plan.steps.forEach((step, index) => {
      const prefix = `steps[${index}]`;
      if (!isObject(step)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      push(errors, nonEmptyString(step.id), `${prefix}.id must be a non-empty string`);
      push(errors, nonEmptyString(step.operation), `${prefix}.operation must be a non-empty string`);
      push(errors, isObject(step.inputs), `${prefix}.inputs must be an object`);
      push(errors, nonEmptyString(step.why), `${prefix}.why must be a non-empty string`);
      push(errors, nonEmptyString(step.expect), `${prefix}.expect must be a non-empty string`);
      push(errors, nonEmptyString(step.verify), `${prefix}.verify must be a non-empty string`);
      if (!Array.isArray(step.effects) || step.effects.length === 0) {
        errors.push(`${prefix}.effects must be a non-empty array`);
      } else {
        for (const effect of step.effects) push(errors, EFFECTS.includes(effect), `${prefix}: unknown effect ${effect}`);
        push(errors, GATES.has(step.gate), `${prefix}.gate must be auto, soft or hard`);
        push(errors, step.gate === gateFor(step.effects), `${prefix}.gate must be ${gateFor(step.effects)}`);
      }
    });
  }

  push(errors, Array.isArray(plan.authorizations), "authorizations must be an array");
  return { ok: errors.length === 0, errors };
}
