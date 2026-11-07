import { gateFor, validateOperation } from "./contracts.mjs";
import { authorizeOperation } from "./authorization.mjs";

const handlers = new Map();
const descriptors = new Map();

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

// The CLI passes every --input value as a string. Convert a string to the
// type the schema declares when the text is an unambiguous value of that type;
// anything else is left as it is and fails validation with a clear message.
function coerceValue(value, type) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (type === "boolean") {
    if (text === "true") return true;
    if (text === "false") return false;
  } else if (type === "integer") {
    if (/^-?\d+$/.test(text)) return Number(text);
  } else if (type === "number") {
    if (text !== "" && Number.isFinite(Number(text))) return Number(text);
  } else if (type === "array") {
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return value;
      }
    }
    return text === "" ? [] : text.split(",").map((item) => item.trim()).filter(Boolean);
  } else if (type === "object") {
    if (text.startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch {
        return value;
      }
    }
  }
  return value;
}

export function coerceInputs(schema, inputs) {
  if (!schema || schema.type !== "object" || !inputs || typeof inputs !== "object" || Array.isArray(inputs)) return inputs;
  const out = { ...inputs };
  for (const [key, definition] of Object.entries(schema.properties || {})) {
    if (key in out && definition && typeof definition.type === "string") out[key] = coerceValue(out[key], definition.type);
  }
  return out;
}

function validateInputs(schema, inputs) {
  const errors = [];
  if (!schema || schema.type !== "object") return errors;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) return ["inputs must be an object"];
  for (const key of schema.required || []) {
    if (!(key in inputs)) errors.push(`missing required input: ${key}`);
  }
  for (const [key, definition] of Object.entries(schema.properties || {})) {
    if (!(key in inputs) || !definition || !definition.type) continue;
    const value = inputs[key];
    if (definition.type === "integer") {
      if (!Number.isInteger(value)) errors.push(`input ${key} must be an integer`);
    } else if (typeOf(value) !== definition.type) {
      errors.push(`input ${key} must be ${definition.type}`);
    }
  }
  return errors;
}

export function registerOperation(descriptor, handler) {
  const result = validateOperation(descriptor);
  if (!result.ok) throw new Error(`Invalid operation ${descriptor?.id || "?"}: ${result.errors.join("; ")}`);
  if (typeof handler !== "function") throw new Error(`Operation ${descriptor.id} has no handler`);
  descriptors.set(descriptor.id, descriptor);
  handlers.set(descriptor.id, handler);
  return descriptor;
}

export function getOperationDescriptor(id) {
  return descriptors.get(id) || null;
}

export function getHandler(id) {
  return handlers.get(id) || null;
}

export async function executeOperation(id, inputs = {}, context = {}) {
  const handler = handlers.get(id);
  if (!handler) {
    return {
      ok: false,
      error: { code: "GMF-E-PLAN-001", message: `Unknown operation: ${id}`, remediation: "Run gmf catalog --json to list operation IDs." },
    };
  }

  const descriptor = descriptors.get(id);
  inputs = coerceInputs(descriptor.inputs, inputs);
  const inputErrors = validateInputs(descriptor.inputs, inputs);
  if (inputErrors.length > 0) {
    return {
      ok: false,
      error: { code: "GMF-E-PLAN-001", message: `Invalid inputs for ${id}: ${inputErrors.join("; ")}`, remediation: "Check the operation input schema in gmf catalog." },
    };
  }

  const authorization = authorizeOperation(descriptor, context);
  if (!authorization.allowed) {
    const effects = (descriptor.effects || []).filter((effect) => !["read", "workspaceWrite"].includes(effect));
    return {
      ok: false,
      error: {
        code: "GMF-E-GATE-001",
        message: `GMF-E-GATE-001: ${id} needs an authorization for ${(authorization.missing || effects).join(" and ")} (${authorization.reason}).`,
        remediation: `Add an authorization to the plan, or pass --authorized ${(authorization.missing || effects).join(",")} --source "<quoted user instruction>".`,
      },
    };
  }

  try {
    const result = await handler(inputs, context);
    return {
      ok: true,
      data: result && typeof result === "object" && "data" in result ? result.data : result,
      evidence: result?.evidence || [],
      effects: descriptor.effects,
      gate: gateFor(descriptor.effects),
      authorization:
        result?.authorization ||
        (authorization.gate === "auto" ? null : { source: authorization.source, gate: authorization.gate }),
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: error.code || "GMF-E-EXEC-001", message: error.message, remediation: error.remediation || "" },
    };
  }
}
