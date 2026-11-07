// tool.list, tool.install and tool.verify: the tool registry through the catalog.

import { getHandler, registerOperation } from "../../core/operations.mjs";
import { authorizeEffects } from "../../core/authorization.mjs";
import { installTool, loadToolRegistry, resolveTool, toolCacheDir, verifyTool } from "../../core/tools.mjs";

function cacheFor(context) {
  return context?.toolCacheDir || toolCacheDir(context?.env || process.env);
}

function registryFor(context) {
  return loadToolRegistry(context?.catalog || { tools: [] });
}

function describe(tool, context) {
  const resolved = resolveTool(tool.id, { cacheDir: cacheFor(context) });
  return {
    id: tool.id,
    name: tool.name,
    purpose: tool.purpose,
    engine: tool.engine,
    license: tool.license,
    installed: Boolean(resolved),
    path: resolved?.path || null,
    version: resolved?.version || null,
    userProvided: tool.source?.type === "system",
    effects: tool.effects,
  };
}

export const toolListOperation = {
  id: "tool.list",
  title: "List registered tools",
  summary: "List every registered tool with its purpose, license, install state and resolved path.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      engine: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      tools: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: ["knowledge/core/toolchain.md"],
  async handler(inputs, context = {}) {
    const tools = Object.values(registryFor(context))
      .filter((tool) => !inputs.engine || tool.engine === inputs.engine || tool.engine === "core")
      .map((tool) => describe(tool, context));
    return { data: { tools } };
  },
};

export const toolInstallOperation = {
  id: "tool.install",
  title: "Install a registered tool",
  summary: "Download and verify a registered tool into the tool cache. Needs a toolInstall authorization from the plan or the user's instruction.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      tool: { type: "string" },
    },
    required: ["tool"],
  },
  outputs: {
    type: "object",
    properties: {
      id: { type: "string" },
      path: { type: "string" },
      version: { type: "string" },
    },
  },
  effects: ["toolInstall", "network"],
  requires: [],
  gates: ["soft"],
  skill: "gmf-implement",
  docs: ["knowledge/core/toolchain.md", "knowledge/core/authorization.md"],
  async handler(inputs, context = {}) {
    const authorization = authorizeEffects(["toolInstall"], context);
    const result = await installTool(inputs.tool, {
      authorized: authorization.allowed,
      source: authorization.source || "",
      catalog: context.catalog,
      cacheDir: cacheFor(context),
      fetchImpl: context.fetch || globalThis.fetch,
    });
    return { data: { id: inputs.tool, ...result }, authorization: { effect: "toolInstall", source: authorization.source || null } };
  },
};

export const toolVerifyOperation = {
  id: "tool.verify",
  title: "Verify an installed tool",
  summary: "Check that a registered tool resolves to an existing path and, when the registry publishes one, matches its size or SHA-256.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      tool: { type: "string" },
    },
    required: ["tool"],
  },
  outputs: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      path: { type: "string" },
      reason: { type: "string" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-verify",
  docs: ["knowledge/core/toolchain.md"],
  async handler(inputs, context = {}) {
    const resolved = resolveTool(inputs.tool, { cacheDir: cacheFor(context) });
    if (!resolved) return { data: { ok: false, path: null, reason: `${inputs.tool} is not installed` } };
    const verified = verifyTool(inputs.tool, { path: resolved.path, catalog: context.catalog });
    return { data: { ok: verified.ok, path: resolved.path, reason: verified.reason || verified.kind || "verified" } };
  },
};

export const toolOperations = [toolListOperation, toolInstallOperation, toolVerifyOperation];

for (const operation of toolOperations) {
  if (!getHandler(operation.id)) registerOperation(operation, operation.handler);
}

export default toolOperations;
