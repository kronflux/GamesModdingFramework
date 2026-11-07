// gmf as a Model Context Protocol server over stdio. Each catalog operation is
// one tool with the operation's input schema, run by the same executor as the
// CLI, so gates, evidence and errors are identical. Handshake-era protocol
// (2025-11-25 and earlier): a modern client probing with server/discover gets
// "method not found" and falls back to initialize, as the 2026-07-28
// compatibility rules describe.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { bootstrap } from "../core/bootstrap.mjs";
import { loadCatalog } from "../core/catalog.mjs";
import { gateFor } from "../core/contracts.mjs";
import { executeOperation } from "../core/operations.mjs";
import { readWorkspace } from "../core/workspace.mjs";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const AUTO_EFFECTS = new Set(["read", "workspaceWrite"]);

// Skills are written as CLI commands; this says how they map to tools.
const COMMAND_MAPPING =
  "Skills show CLI commands: `gmf run unity.deploy --input modDir=X` is the tool unity_deploy with {\"modDir\": \"X\"}; `gmf knowledge show <id>` is knowledge_show and `gmf skill show <name>` is skill_show; --authorized and --source are the authorized and authorizationSource arguments.";
const PROMPT_PREFIX = `Over MCP, run each \`gmf run <operation>\` below as the tool named after the operation with \`_\` for \`.\`. ${COMMAND_MAPPING}`;

export function toolName(operationId) {
  return operationId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function packageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// MCP tool definitions for the catalog operations.
export function toolsFromCatalog(catalog) {
  return (catalog.operations || []).map((operation) => {
    const effects = operation.effects || [];
    const gate = gateFor(effects);
    const gated = effects.filter((effect) => !AUTO_EFFECTS.has(effect));
    const schema = structuredClone(operation.inputs || { type: "object", properties: {} });
    schema.type = "object";
    schema.properties = schema.properties || {};
    schema.properties.workspace = {
      type: "string",
      description: "The gmf workspace folder (holds gmf.json). Defaults to the server's working folder.",
    };
    let description = `${operation.summary} Effects: ${effects.join(", ") || "none"}; gate: ${gate}.`;
    if (gate !== "auto") {
      schema.properties.authorized = {
        type: "array",
        items: { type: "string", enum: gated },
        description: "Effects the user explicitly approved for this call.",
      };
      schema.properties.authorizationSource = {
        type: "string",
        description: "The user's instruction that approved them, quoted.",
      };
      description += " Needs authorized and authorizationSource from the user's instruction, or a plan authorization.";
    }
    return {
      name: toolName(operation.id),
      title: operation.title,
      description,
      inputSchema: schema,
      annotations: {
        title: operation.title,
        readOnlyHint: effects.every((effect) => effect === "read"),
        destructiveHint: effects.includes("destructive"),
        openWorldHint: effects.includes("network"),
      },
      operationId: operation.id,
    };
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function createMcpServer({ root, env = process.env, cwd = process.cwd() } = {}) {
  const catalog = loadCatalog(root);
  const tools = toolsFromCatalog(catalog);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const publicTools = tools.map(({ operationId, ...tool }) => tool);
  let ready = null;

  async function callTool(params = {}) {
    const tool = byName.get(params.name);
    if (!tool) return { error: [-32602, `Unknown tool: ${params.name}`] };
    ready = ready || bootstrap(root).catch((error) => {
      ready = null;
      throw error;
    });
    await ready;
    const { authorized, authorizationSource, workspace, ...inputs } = params.arguments || {};
    const flags = { json: true };
    if (authorized !== undefined) flags.authorized = Array.isArray(authorized) ? authorized.join(",") : String(authorized);
    if (authorizationSource !== undefined) flags.source = String(authorizationSource);
    const context = {
      root,
      catalog,
      workspace: readWorkspace(workspace || env.GMF_WORKSPACE || env.CLAUDE_PROJECT_DIR || cwd),
      env,
      flags,
    };
    const result = await executeOperation(tool.operationId, inputs, context);
    return {
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: !result.ok,
      },
    };
  }

  async function handle(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id, -32600, "Invalid request");
    }
    const { id, method, params } = message;
    // Notifications (no id) never get a reply.
    if (id === undefined) return null;
    try {
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
              capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
              serverInfo: { name: "gmf", title: "Game Modding Framework", version: packageVersion(root) },
              instructions:
                `gmf operations for Unity and Unreal game modding. Start with game_detect or game_profile. Each skill is a prompt, and skill_show and knowledge_show return skills and notes as text. ${COMMAND_MAPPING} Tools with a soft gate need the user's explicit approval: pass authorized and authorizationSource.`,
            },
          };
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: publicTools } };
        case "tools/call": {
          const outcome = await callTool(params);
          return outcome.error ? rpcError(id, ...outcome.error) : { jsonrpc: "2.0", id, result: outcome.result };
        }
        // Skills as prompts, for MCP clients that have no plugin skills.
        case "prompts/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { prompts: (catalog.skills || []).map((skill) => ({ name: skill.name, title: skill.name, description: skill.summary })) },
          };
        case "prompts/get": {
          const skill = (catalog.skills || []).find((entry) => entry.name === params?.name);
          if (!skill) return rpcError(id, -32602, `Unknown prompt: ${params?.name}`);
          const text = fs.readFileSync(path.join(root, ...skill.path.split("/")), "utf8");
          return {
            jsonrpc: "2.0",
            id,
            result: { description: skill.summary, messages: [{ role: "user", content: { type: "text", text: `${PROMPT_PREFIX}\n\n${text}` } }] },
          };
        }
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      return rpcError(id, -32603, error.message || "Internal error");
    }
  }

  return { handle, tools: publicTools };
}

async function handleLine(server, line) {
  if (!line.trim()) return null;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  return server.handle(message);
}

// Serve newline-delimited JSON-RPC from a string (tests, the docs check) and
// return the output text.
export async function serveText(server, text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const response = await handleLine(server, line);
    if (response) out.push(JSON.stringify(response));
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

// Serve stdin to stdout until stdin closes. Console output from operations goes
// to stderr, because anything else on stdout breaks the protocol.
export async function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  console.log = console.info = console.debug = (...args) => console.error(...args);
  const pending = new Set();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const task = handleLine(server, line).then((response) => {
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
