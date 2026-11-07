import fs from "node:fs";
import path from "node:path";
import { gateFor, validatePlan as validatePlanSchema } from "./contracts.mjs";
import { resolveAuthorization } from "./authorization.mjs";
import { executeOperation } from "./operations.mjs";
import { readJson, writeJson } from "./workspace.mjs";
import { acknowledgeAntiCheat, antiCheatWarning, assertPolicy, createBackup } from "./safety.mjs";

const SOFT_EFFECTS = new Set(["gameWrite", "toolInstall", "network", "launchGame", "antiCheat"]);
const HARD_EFFECTS = new Set(["destructive", "credentials", "piracy"]);

function codedError(code, message, remediation = "") {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modName(profile) {
  const raw = profile?.game?.name || "Game";
  const words = String(raw)
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const cleaned = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return `${cleaned || "Game"}Mod`;
}

function buildInputs(operation, profile, base = {}) {
  const properties = operation?.inputs?.properties || {};
  const values = {
    gameDir: profile?.game?.installDir || null,
    backend:
      profile?.runtime?.backend && profile.runtime.backend !== "unknown" ? profile.runtime.backend : null,
    name: base.name || null,
    author: profile?.author || profile?.game?.author || "unknown",
    loader:
      base.loader ||
      (profile?.loader?.id && profile.loader.id !== "unknown" && profile.loader.id !== "none" ? profile.loader.id : null),
    modDir: base.modDir || null,
    type: base.type || "lua",
    kinds: ["objects", "usmap", "headers"],
    profile: "gmf.profile.json",
    goal: base.goal || null,
    id: base.tool || null,
    outputDir: base.outputDir || null,
  };

  const inputs = {};
  for (const key of operation?.inputs?.required || []) {
    const value = values[key];
    if (value === null || value === undefined || value === "") return null;
    inputs[key] = value;
  }
  if (properties.outputDir && values.outputDir && inputs.outputDir === undefined) {
    inputs.outputDir = values.outputDir;
  }
  if (properties.type && values.type && inputs.type === undefined) inputs.type = values.type;
  if (properties.loader && base.loader && inputs.loader === undefined) inputs.loader = base.loader;
  if (properties.kinds && values.kinds && inputs.kinds === undefined) inputs.kinds = values.kinds;
  return inputs;
}

// Draft a starting plan from the profile and the catalog. It never executes a
// step. Soft-gated steps are left without authorizations so the user or the
// plan review can supply a source.
export function draftPlan({ goal, profile, catalog } = {}) {
  if (typeof goal !== "string" || !goal.trim()) {
    throw codedError("GMF-E-PLAN-001", "GMF-E-PLAN-001: a goal is required to draft a plan", "Pass --goal with the mod goal.");
  }

  const operations = new Map(((catalog && catalog.operations) || []).map((operation) => [operation.id, operation]));
  const engine = profile?.engine?.id || "unknown";
  const name = modName(profile);
  const modDir = `mods/${name}`;
  const installed = new Set(
    ((profile && profile.tools) || []).filter((tool) => tool && tool.installed).map((tool) => tool.id),
  );

  const steps = [];
  const notes = [];
  const missingTools = [];
  const installSteps = new Map();
  let counter = 0;

  const makeStep = (operation, inputs, why, expect, verify) => {
    counter += 1;
    return {
      id: String(counter),
      operation: operation.id,
      inputs,
      why,
      expect,
      verify,
      effects: [...operation.effects],
      gate: gateFor(operation.effects),
    };
  };

  const pushStep = (operationId, why, expect, verify, base = {}) => {
    const operation = operations.get(operationId);
    if (!operation) {
      notes.push({
        kind: "missing-operation",
        operation: operationId,
        message: `The catalog has no ${operationId} operation. Regenerate the catalog or add the capability.`,
      });
      return null;
    }

    const inputs = buildInputs(operation, profile, { ...base, name, modDir, goal });
    if (!inputs) {
      notes.push({
        kind: "missing-input",
        operation: operationId,
        message: `Cannot draft ${operationId}: one of its required inputs is unknown from the profile.`,
      });
      return null;
    }

    for (const tool of operation.requires || []) {
      if (installed.has(tool) || installSteps.has(tool)) continue;
      const installOperation = operations.get("tool.install");
      const installInputs = installOperation ? buildInputs(installOperation, profile, { tool }) : null;
      if (installOperation && installInputs) {
        const installStep = makeStep(
          installOperation,
          installInputs,
          `Install ${tool}, which ${operationId} requires.`,
          `${tool} is installed and its verification is recorded.`,
          `gmf tool verify ${tool}`,
        );
        steps.push(installStep);
        installSteps.set(tool, installStep.id);
      } else {
        missingTools.push({
          tool,
          operation: operationId,
          step: null,
          note: `Install ${tool} before this step; the catalog has no tool.install operation for it.`,
        });
      }
    }

    const step = makeStep(operation, inputs, why, expect, verify);
    steps.push(step);

    for (const tool of operation.requires || []) {
      if (installed.has(tool)) continue;
      const installStep = installSteps.get(tool);
      if (installStep) {
        missingTools.push({ tool, operation: operationId, step: step.id, installStep });
      } else if (!missingTools.some((entry) => entry.tool === tool && entry.operation === operationId)) {
        missingTools.push({ tool, operation: operationId, step: step.id, installStep: null });
      }
    }
    return step;
  };

  if (engine === "unity") {
    if (!profile?.loader?.installed) {
      pushStep(
        "unity.setup_loader",
        "Install a mod loader; code mods cannot load without one.",
        "The loader files are next to the game executable and detection reports the loader.",
        "Launch the game once, then rerun gmf investigate and check the loader and interop folder.",
        { loader: profile?.runtime?.backend === "il2cpp" ? "bepinex6-il2cpp" : "bepinex5" },
      );
    }
    if (profile?.runtime?.backend === "mono" || profile?.runtime?.backend === "il2cpp") {
      pushStep(
        "unity.decompile",
        "Read the shipped assemblies before choosing a patch target.",
        "Decompiled output is under decompiled/ with a report.",
        "Read the decompile report and list the assemblies.",
        { outputDir: "decompiled" },
      );
    }
    pushStep(
      "unity.scaffold",
      "Create a mod project for the detected loader and backend.",
      "A buildable project exists under mods/.",
      "Run unity.build and check the project files.",
      { outputDir: modDir },
    );
    pushStep(
      "unity.build",
      `Build ${name} against the game assemblies.`,
      "The build exits 0 and writes the plugin assembly.",
      "Run unity.build and read the exact command, exit code and log tail.",
    );
    pushStep(
      "unity.deploy",
      "Copy the built plugin into the loader folder after backing up any existing file.",
      "The plugin is under the profile deploy path.",
      "Compare the deployed file hash with the built file hash.",
    );
    pushStep(
      "unity.validate",
      "Resolve every Harmony target against the game assemblies.",
      "Validation reports every resolved and missing target.",
      "Read the validation result and its evidence.",
    );
    pushStep(
      "unity.package",
      "Package the mod for local release.",
      "A zip exists with the plugin and its metadata.",
      "List the zip contents and compare it with the mod folder.",
    );
  } else if (engine === "unreal") {
    if (!profile?.loader?.installed) {
      pushStep(
        "unreal.setup_ue4ss",
        "Install UE4SS so Lua and C++ mods can load.",
        "UE4SS is installed and its version is recorded.",
        "Run unreal.dump and read the UE4SS log.",
      );
    }
    pushStep(
      "unreal.dump",
      "Dump the object model before choosing a hook target.",
      "Object, usmap and header dumps exist under dumps/.",
      "Search the dump for the target class and method.",
      { outputDir: "dumps" },
    );
    pushStep(
      "unreal.scaffold",
      "Create a Lua mod project for the game.",
      "The mod has Scripts/main.lua and enabled.txt.",
      "Run unreal.build and check the files.",
      { type: "lua" },
    );
    pushStep(
      "unreal.build",
      `Build or check ${name}.`,
      "The build step exits 0 or reports the exact command to run.",
      "Read the exit code and log tail.",
      { type: "lua" },
    );
    pushStep(
      "unreal.deploy",
      "Copy the mod into the UE4SS Mods folder after backing up any existing files.",
      "The mod folder is under the UE4SS Mods path.",
      "Check main.lua and enabled.txt in the deployed folder.",
      { type: "lua" },
    );
    pushStep(
      "unreal.validate",
      "Run the Lua structural and reference checks.",
      "Validation reports every missing module, field or object path.",
      "Read the validation result and its evidence.",
      { type: "lua" },
    );
    pushStep(
      "unreal.package",
      "Package the mod for local release.",
      "A zip or pak exists with the mod files.",
      "List the package contents.",
      { type: "lua" },
    );
  } else {
    pushStep(
      "game.inventory",
      "List the game folder so the engine can be selected manually.",
      "An inventory with counts is returned.",
      "Read the inventory and choose an engine.",
    );
    notes.push({
      kind: "engine-selection",
      message: "The engine is unknown. Select an engine manually before scaffolding a mod.",
    });
  }

  const risks = [];
  const markers = (profile && profile.markers && profile.markers.antiCheat) || [];
  if (markers.length > 0) risks.push(antiCheatWarning(markers, { source: "profile" }));

  for (const item of (profile && profile.unknowns) || []) {
    if (!item) continue;
    notes.push({
      kind: "unknown",
      id: item.id || null,
      question: item.question || "",
      severity: item.severity || "low",
      nextProbe: item.nextProbe || "",
    });
  }

  return {
    version: 1,
    goal,
    profile: "gmf.profile.json",
    steps,
    authorizations: [],
    missingTools,
    risks,
    notes,
  };
}

function authorizationFor(plan, step, effect) {
  for (const authorization of (plan && plan.authorizations) || []) {
    if (!authorization || authorization.effect !== effect) continue;
    if (typeof authorization.source !== "string" || !authorization.source.trim()) continue;
    if (
      authorization.scope &&
      authorization.scope !== "plan" &&
      authorization.scope !== `step:${step.id}` &&
      authorization.scope !== step.operation
    ) {
      continue;
    }
    return authorization;
  }
  return null;
}

// Check every step and return every problem. requireAuthorizations can be
// turned off by the apply path, which resolves overrides per step instead.
export function validatePlan(plan, catalog, { profile = null, requireAuthorizations = true } = {}) {
  const errors = [];
  const schema = validatePlanSchema(plan);
  errors.push(...schema.errors);
  if (!isObject(plan)) return { ok: false, errors };

  const operations = new Map(((catalog && catalog.operations) || []).map((operation) => [operation.id, operation]));
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const installed = new Set(
    ((profile && profile.tools) || []).filter((tool) => tool && tool.installed).map((tool) => tool.id),
  );
  const installIndexes = new Map();
  steps.forEach((step, index) => {
    if (step && step.operation === "tool.install" && isObject(step.inputs) && typeof step.inputs.id === "string") {
      if (!installIndexes.has(step.inputs.id)) installIndexes.set(step.inputs.id, index);
    }
  });

  const seenIds = new Set();
  steps.forEach((step, index) => {
    if (!isObject(step)) return;
    if (typeof step.id === "string") {
      if (seenIds.has(step.id)) errors.push(`step ${step.id}: duplicate step id (GMF-E-PLAN-001)`);
      seenIds.add(step.id);
    }

    const operation = operations.get(step.operation);
    if (!operation) {
      errors.push(`step ${step.id}: unknown operation ${step.operation} (GMF-E-PLAN-001)`);
      return;
    }

    const inputs = isObject(step.inputs) ? step.inputs : {};
    for (const key of operation.inputs?.required || []) {
      const value = inputs[key];
      if (value === undefined || value === null || value === "") {
        errors.push(`step ${step.id}: ${operation.id} is missing required input ${key} (GMF-E-PLAN-001)`);
      }
    }

    const declared = Array.isArray(step.effects) ? step.effects : [];
    for (const effect of operation.effects || []) {
      if (!declared.includes(effect)) {
        errors.push(`step ${step.id}: effects do not cover ${effect} required by ${operation.id} (GMF-E-PLAN-001)`);
      }
    }

    for (const effect of declared) {
      if (effect === "credentials" || effect === "piracy") {
        errors.push(`step ${step.id}: ${effect} is always refused (GMF-E-POLICY-001)`);
      } else if (effect === "destructive") {
        errors.push(
          `step ${step.id}: destructive requires explicit user approval and cannot be authorized by a plan (GMF-E-GATE-001)`,
        );
      }
    }

    if (requireAuthorizations) {
      for (const effect of declared) {
        if (!SOFT_EFFECTS.has(effect)) continue;
        if (!authorizationFor(plan, step, effect)) {
          errors.push(`step ${step.id}: ${effect} requires an authorization with a source (GMF-E-GATE-001)`);
        }
      }
    }

    for (const tool of operation.requires || []) {
      if (installed.has(tool)) continue;
      const installIndex = installIndexes.get(tool);
      if (installIndex !== undefined && installIndex < index) continue;
      errors.push(
        `step ${step.id}: required tool ${tool} is not installed${
          installIndex !== undefined ? " before this step" : " and no tool.install step provides it"
        } (GMF-E-TOOL-001)`,
      );
    }
  });

  return { ok: errors.length === 0, errors };
}

function recordRun(workspace, record) {
  if (!workspace || !workspace.root) return;
  const file = path.join(workspace.root, "gmf.plan.json");
  const data = readJson(file, null) || {
    version: 1,
    goal: "",
    profile: "gmf.profile.json",
    steps: [],
    authorizations: [],
  };
  data.runs = Array.isArray(data.runs) ? data.runs : [];
  data.runs.push({ ...record, recordedAt: new Date().toISOString() });
  writeJson(file, data);
}

function failure(step, authorization, error) {
  return {
    step: step.id,
    operation: step.operation,
    ok: false,
    gate: authorization ? authorization.gate : gateFor(step.effects),
    effects: step.effects,
    authorizationSource: authorization ? authorization.source : null,
    warnings: [],
    data: null,
    error,
  };
}

// Run the steps in order. A step whose effects are not authorized stops the
// plan unless the step is optional. Hard gates are never satisfied here.
export async function applyPlan(plan, context = {}) {
  const catalog = context.catalog || { operations: [] };
  const profile = context.profile || (context.workspace && context.workspace.profile) || null;
  const nested = validatePlan(plan, catalog, { profile, requireAuthorizations: false });
  if (!nested.ok) {
    return {
      ok: false,
      results: [],
      error: { code: "GMF-E-PLAN-001", message: nested.errors.join(" | "), errors: nested.errors },
    };
  }

  const overrides = Array.isArray(context.overrides) ? context.overrides : [];
  const results = [];

  stepLoop: for (const step of plan.steps) {
    const authorization = resolveAuthorization({ effects: step.effects, plan, overrides });
    if (!authorization.allowed) {
      const error = {
        code: "GMF-E-GATE-001",
        message: `authorization required for ${step.effects.join(", ")} of step ${step.id}`,
        remediation: "Add an authorization to the plan or pass --authorized <effect> --source <text>.",
      };
      results.push(failure(step, authorization, error));
      recordRun(context.workspace, {
        step: step.id,
        operation: step.operation,
        effects: step.effects,
        gate: authorization.gate,
        authorizationSource: null,
        ok: false,
      });
      if (step.optional) continue;
      return { ok: false, results, error };
    }

    try {
      for (const effect of step.effects) {
        assertPolicy(effect, {
          approved: false,
          approvedBy: null,
          source: authorization.source,
          markers: (profile && profile.markers && profile.markers.antiCheat) || [],
        });
      }
    } catch (error) {
      const record = failure(step, authorization, {
        code: error.code || "GMF-E-POLICY-001",
        message: error.message,
        remediation: error.remediation || "",
      });
      results.push(record);
      recordRun(context.workspace, {
        step: step.id,
        operation: step.operation,
        effects: step.effects,
        gate: authorization.gate,
        authorizationSource: authorization.source,
        ok: false,
      });
      if (step.optional) continue;
      return { ok: false, results, error: record.error };
    }

    const warnings = [];
    const markers = (profile && profile.markers && profile.markers.antiCheat) || [];
    const antiCheatStep = step.effects.includes("antiCheat");
    if (antiCheatStep || (markers.length > 0 && step.effects.includes("gameWrite"))) {
      const source = authorization.source || `plan step ${step.id}`;
      warnings.push(antiCheatWarning(markers, { source }));
      if (markers.length > 0 && context.workspace) {
        acknowledgeAntiCheat(context.workspace, {
          markers,
          source,
          operation: step.operation,
          step: step.id,
        });
      }
    }

    let backup = null;
    const restoresBackup = step.operation === "generic.restore" || Boolean(step.inputs && step.inputs.backupPath);
    if (step.effects.includes("gameWrite") && context.workspace && !restoresBackup) {
      for (const key of ["gamePath", "target", "path"]) {
        const candidate = step.inputs && step.inputs[key];
        if (typeof candidate !== "string" || !candidate.trim()) continue;
        const resolved = path.resolve(context.cwd || context.workspace.root, candidate);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
        try {
          backup = createBackup(context.workspace, resolved);
        } catch (error) {
          const record = failure(step, authorization, {
            code: "GMF-E-GATE-001",
            message: `a game write that cannot be backed up is refused: ${error.message}`,
            remediation: "Make the target readable and writable, or do not overwrite it.",
          });
          results.push(record);
          recordRun(context.workspace, {
            step: step.id,
            operation: step.operation,
            effects: step.effects,
            gate: authorization.gate,
            authorizationSource: authorization.source,
            ok: false,
          });
          if (step.optional) continue stepLoop;
          return { ok: false, results, error: record.error };
        }
        break;
      }
    }

    const started = Date.now();
    const outcome = await executeOperation(step.operation, step.inputs, {
      ...context,
      plan,
      step,
      authorization,
    });
    const result = {
      step: step.id,
      operation: step.operation,
      ok: outcome.ok,
      gate: authorization.gate,
      effects: step.effects,
      authorizationSource: authorization.source,
      warnings,
      backup,
      data: outcome.ok ? outcome.data : null,
      error: outcome.ok ? null : outcome.error,
      durationMs: Date.now() - started,
    };
    results.push(result);
    recordRun(context.workspace, {
      step: step.id,
      operation: step.operation,
      effects: step.effects,
      gate: authorization.gate,
      authorizationSource: authorization.source,
      ok: outcome.ok,
    });

    if (!outcome.ok && !step.optional) return { ok: false, results, error: outcome.error };
  }

  return { ok: true, results };
}

export function readPlanInput(plan, context = {}) {
  if (isObject(plan)) return plan;
  if (typeof plan === "string" && plan.trim()) {
    const base = (context.workspace && context.workspace.root) || context.root || process.cwd();
    const file = path.isAbsolute(plan) ? plan : path.resolve(base, plan);
    const data = readJson(file, null);
    if (!data) {
      throw codedError(
        "GMF-E-PLAN-001",
        `GMF-E-PLAN-001: cannot read the plan at ${file}`,
        "Pass a plan object or an existing plan path.",
      );
    }
    return data;
  }
  throw codedError("GMF-E-PLAN-001", "GMF-E-PLAN-001: a plan is required", "Draft a plan first with plan.draft.");
}

export function resolveProfileInput(profile, context = {}) {
  if (isObject(profile)) return profile;
  if (typeof profile === "string" && profile.trim()) {
    const base = (context.workspace && context.workspace.root) || context.root || process.cwd();
    const file = path.isAbsolute(profile) ? profile : path.resolve(base, profile);
    const data = readJson(file, null);
    if (!data) {
      throw codedError(
        "GMF-E-PLAN-001",
        `GMF-E-PLAN-001: cannot read the profile at ${file}`,
        "Run gmf investigate first or pass a profile object.",
      );
    }
    return data;
  }
  const fallback = context.profile || (context.workspace && context.workspace.profile) || null;
  if (!fallback) {
    throw codedError(
      "GMF-E-PLAN-001",
      "GMF-E-PLAN-001: a profile is required to draft a plan",
      "Run gmf investigate first.",
    );
  }
  return fallback;
}

export function normalizeOverrides(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (typeof item === "string" ? { effect: item, source: "plan input" } : item))
    .filter((item) => item && typeof item === "object" && typeof item.effect === "string");
}

export { HARD_EFFECTS, SOFT_EFFECTS };
