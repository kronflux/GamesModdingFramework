import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exitCodeFor, formatResult, parseArgs } from "./args.mjs";
import { bootstrap } from "../core/bootstrap.mjs";
import { loadCatalog } from "../core/catalog.mjs";
import { handleHook } from "../core/hooks.mjs";
import { executeOperation } from "../core/operations.mjs";
import { readWorkspace, writeJson } from "../core/workspace.mjs";

function errorResult(code, message, remediation = "") {
  return { ok: false, error: { code, message, remediation } };
}

// Every command the dispatcher knows. test/cli-docs.test.mjs checks that each
// command named in the documentation is in this list.
export const COMMANDS = Object.freeze({
  version: "print the framework and catalog versions",
  catalog: "list operations, tools, knowledge, templates and skills ([--engine <id>] [--kind <kind>])",
  games: "list game folders under the configured roots and Steam libraries ([--root <dir>])",
  detect: "identify a game (--game <dir>)",
  investigate: "build an evidence-backed profile (--game <dir> [--workspace <dir>])",
  init: "create a workspace (--game <dir> [--workspace <dir>] [--author <name>])",
  profile: "print the current workspace profile",
  plan: "draft, validate or apply a plan (plan draft --goal <text> | plan validate [<file>] | plan apply [<file>])",
  apply: "alias for plan apply (apply [<file>] [--authorized <effect> --source <text>])",
  verify: "run the plan's verify commands and record the results ([--plan <file>])",
  run: "run any catalog operation (run <id> --input key=value)",
  setup: "report or install the tools an engine needs ([--engine <id>] [--install])",
  tool: "list, install or verify a registered tool (tool list | tool install <id> | tool verify <id>)",
  knowledge: "search notes or print one (knowledge search <query> [--engine <id>] [--tag <tag>] | knowledge show <id>)",
  skill: "list skills or print one (skill list | skill show <name>)",
  package: "package the workspace mod for its engine ([--mod <name>] [--out <path>])",
  status: "print the current workspace state",
  doctor: "print environment and catalog checks",
  hook: "run a host hook event (hook <event>)",
  mcp: "serve every catalog operation as an MCP tool over stdio",
});

function helpText() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length)) + 2;
  const lines = Object.entries(COMMANDS).map(([name, text]) => `  ${name.padEnd(width)}${text}`);
  return `gmf <command> [options]

Commands:
${lines.join("\n")}

Options:
  --json  --game <dir>  --workspace <dir>  --author <name>  --goal <text>  --engine <id>
  --input key=value  --authorized <effect>  --source <text>  --plan <file>  --mod <name>  --out <path>
`;
}

function subcommand(positionals) {
  return { verb: positionals[0] || null, rest: positionals.slice(1) };
}

function authorizationInputs(flags) {
  const inputs = {};
  if (typeof flags.authorized === "string") inputs.authorized = flags.authorized;
  if (typeof flags.source === "string") inputs.source = flags.source;
  return inputs;
}

function engineFor(context, flags) {
  return flags.engine || context.workspace?.config?.game?.engine || context.workspace?.profile?.engine?.id || null;
}

function packageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// The framework's own folder (two levels above this file). The current folder
// is usually a workspace, which has no catalog or engine modules.
const FRAMEWORK_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function rootFor(env) {
  return env.GMF_ROOT || FRAMEWORK_ROOT;
}

function contextFor(env) {
  const root = rootFor(env);
  return {
    root,
    catalog: loadCatalog(root),
    workspace: readWorkspace(env.GMF_WORKSPACE || process.cwd()),
    env,
  };
}

async function dispatch(command, positionals, flags, env) {
  const context = contextFor(env);

  switch (command) {
    case "version":
      return {
        ok: true,
        data: { name: "gmf", version: packageVersion(context.root), node: process.version, catalogVersion: context.catalog.version },
      };
    case "catalog": {
      if (!flags.engine && !flags.kind) return { ok: true, data: context.catalog };
      const kinds = ["operation", "tool", "knowledge", "template", "skill"];
      if (flags.kind && !kinds.includes(flags.kind)) {
        return errorResult("GMF-E-USAGE-001", `Unknown catalog kind: ${flags.kind}`, `Use one of ${kinds.join(", ")}.`);
      }
      const byEngine = (entries) => (flags.engine ? entries.filter((e) => !e.engine || e.engine === flags.engine || e.engine === "core") : entries);
      const data = { version: context.catalog.version };
      for (const kind of kinds) {
        if (flags.kind && flags.kind !== kind) continue;
        data[`${kind}s`] = byEngine(context.catalog[`${kind}s`] || []);
      }
      return { ok: true, data };
    }
    case "games": {
      await bootstrap(context.root);
      const gamesContext = flags.root ? { ...context, env: { ...context.env, GMF_GAME_ROOTS: flags.root } } : context;
      return executeOperation("game.games", {}, { ...gamesContext, flags });
    }
    case "apply":
      return dispatch("plan", ["apply", ...positionals], flags, env);
    case "plan": {
      const { verb, rest } = subcommand(positionals);
      await bootstrap(context.root);
      const defaultPlan = context.workspace?.root ? path.join(context.workspace.root, "gmf.plan.json") : null;
      if (verb === "draft") {
        if (!flags.goal) return errorResult("GMF-E-USAGE-001", "plan draft needs --goal <text>", "Describe the mod goal in one sentence.");
        const target = flags.out || defaultPlan;
        const targetPath = target ? (path.isAbsolute(target) ? target : path.resolve(process.cwd(), target)) : null;
        if (targetPath && fs.existsSync(targetPath) && !flags.force) {
          return errorResult(
            "GMF-E-USAGE-001",
            `plan draft would overwrite ${targetPath}`,
            "Pass --force to replace the existing plan, or --out <path> to write elsewhere.",
          );
        }
        const drafted = await executeOperation("plan.draft", { goal: flags.goal }, { ...context, flags });
        if (drafted.ok && targetPath && drafted.data?.plan) {
          writeJson(targetPath, drafted.data.plan);
          drafted.data.file = targetPath;
        }
        return drafted;
      }
      if (verb === "validate" || verb === "apply") {
        const plan = rest[0] || flags.plan || defaultPlan;
        if (!plan) return errorResult("GMF-E-USAGE-001", `plan ${verb} needs a plan file`, "Pass the plan path or run it inside a workspace with gmf.plan.json.");
        const id = verb === "validate" ? "plan.validate" : "plan.apply";
        return executeOperation(id, { plan, ...(verb === "apply" ? authorizationInputs(flags) : {}) }, { ...context, flags });
      }
      return errorResult("GMF-E-USAGE-001", "plan needs draft, validate or apply", "Run gmf plan draft --goal <text>, gmf plan validate [<file>] or gmf plan apply [<file>].");
    }
    case "verify": {
      await bootstrap(context.root);
      const plan = flags.plan || positionals[0] || undefined;
      return executeOperation("verify.plan", plan ? { plan } : {}, { ...context, flags });
    }
    case "setup": {
      await bootstrap(context.root);
      const engine = engineFor(context, flags);
      const list = await executeOperation("tool.list", engine ? { engine } : {}, { ...context, flags });
      if (!list.ok || !flags.install) return list;
      const installed = [];
      for (const tool of list.data.tools) {
        if (tool.installed || tool.userProvided) continue;
        const result = await executeOperation("tool.install", { tool: tool.id, ...authorizationInputs(flags) }, { ...context, flags });
        installed.push({ id: tool.id, ok: result.ok, error: result.ok ? null : result.error });
        if (!result.ok && result.error?.code === "GMF-E-GATE-001") return result;
      }
      const failed = installed.filter((entry) => !entry.ok);
      if (failed.length > 0) {
        return {
          ok: false,
          data: { engine, tools: list.data.tools, installed },
          error: {
            code: failed[0].error?.code || "GMF-E-TOOL-001",
            message: `${failed.length} tool install(s) failed: ${failed.map((entry) => `${entry.id} (${entry.error?.message || "unknown error"})`).join("; ")}`,
            remediation: failed[0].error?.remediation || "Read each error, fix the cause and run gmf setup --install again.",
          },
        };
      }
      return { ok: true, data: { engine, tools: list.data.tools, installed } };
    }
    case "tool": {
      const { verb, rest } = subcommand(positionals);
      await bootstrap(context.root);
      if (verb === "list") return executeOperation("tool.list", flags.engine ? { engine: flags.engine } : {}, { ...context, flags });
      const id = rest[0] || flags.tool;
      if ((verb === "install" || verb === "verify") && !id) {
        return errorResult("GMF-E-USAGE-001", `tool ${verb} needs a tool id`, "Run gmf tool list to see the ids.");
      }
      if (verb === "install") return executeOperation("tool.install", { tool: id, ...authorizationInputs(flags) }, { ...context, flags });
      if (verb === "verify") return executeOperation("tool.verify", { tool: id }, { ...context, flags });
      return errorResult("GMF-E-USAGE-001", "tool needs list, install or verify", "Run gmf tool list, gmf tool install <id> or gmf tool verify <id>.");
    }
    case "knowledge": {
      const { verb, rest } = subcommand(positionals);
      await bootstrap(context.root);
      if (verb === "search") {
        const query = rest.join(" ").trim();
        if (!query) return errorResult("GMF-E-USAGE-001", "knowledge search needs a query", "Pass one or more words.");
        const inputs = { query };
        if (flags.engine) inputs.engine = flags.engine;
        if (flags.tag) inputs.tag = flags.tag;
        return executeOperation("knowledge.search", inputs, { ...context, flags });
      }
      if (verb === "show") {
        if (!rest[0]) return errorResult("GMF-E-USAGE-001", "knowledge show needs an id", "Run gmf knowledge search <query> to find an id.");
        return executeOperation("knowledge.show", { id: rest[0] }, { ...context, flags });
      }
      return errorResult("GMF-E-USAGE-001", "knowledge needs search or show", "Run gmf knowledge search <query> or gmf knowledge show <id>.");
    }
    case "skill": {
      const { verb, rest } = subcommand(positionals);
      await bootstrap(context.root);
      if (verb === "list") return executeOperation("skill.list", {}, { ...context, flags });
      if (verb === "show") {
        if (!rest[0]) return errorResult("GMF-E-USAGE-001", "skill show needs a name", "Run gmf skill list.");
        return executeOperation("skill.show", { name: rest[0] }, { ...context, flags });
      }
      return errorResult("GMF-E-USAGE-001", "skill needs list or show", "Run gmf skill list or gmf skill show <name>.");
    }
    case "package": {
      await bootstrap(context.root);
      const engine = engineFor(context, flags);
      if (engine !== "unity" && engine !== "unreal") {
        return errorResult("GMF-E-USAGE-001", "package needs a Unity or Unreal workspace", "Run gmf init inside the workspace or pass --engine unity|unreal.");
      }
      const inputs = {};
      if (flags.mod) inputs.modDir = path.isAbsolute(flags.mod) ? flags.mod : path.join(context.workspace?.root || process.cwd(), "mods", flags.mod);
      if (flags.out) inputs.out = flags.out;
      return executeOperation(`${engine}.package`, inputs, { ...context, flags });
    }
    case "run": {
      const id = positionals[0];
      if (!id) {
        return errorResult("GMF-E-USAGE-001", "run needs an operation id", "Run gmf catalog --json to list operation IDs.");
      }
      await bootstrap(context.root);
      return executeOperation(id, flags.input || {}, { ...context, flags });
    }
    case "detect": {
      const gameDir = flags.game || context.workspace?.local?.gameDir;
      if (!gameDir) {
        return errorResult("GMF-E-USAGE-001", "detect needs --game <dir>", "Pass the game install folder.");
      }
      await bootstrap(context.root);
      return executeOperation("game.detect", { gameDir }, { ...context, flags });
    }
    case "investigate": {
      const gameDir = flags.game || context.workspace?.local?.gameDir;
      if (!gameDir) {
        return errorResult("GMF-E-USAGE-001", "investigate needs --game <dir>", "Pass the game install folder.");
      }
      await bootstrap(context.root);
      return executeOperation("game.profile", { gameDir }, { ...context, flags });
    }
    case "init": {
      const gameDir = flags.game || context.workspace?.local?.gameDir;
      if (!gameDir) {
        return errorResult("GMF-E-USAGE-001", "init needs --game <dir>", "Pass the game install folder.");
      }
      await bootstrap(context.root);
      return executeOperation(
        "workspace.init",
        { gameDir, workspaceDir: flags.workspace || process.cwd(), author: flags.author || "" },
        { ...context, flags },
      );
    }
    case "profile":
      return { ok: true, data: context.workspace?.profile || null };
    case "status":
      return {
        ok: true,
        data: context.workspace
          ? {
              root: context.workspace.root,
              config: context.workspace.config,
              local: context.workspace.local,
              profile: context.workspace.profile,
            }
          : null,
      };
    case "doctor":
      return {
        ok: true,
        data: {
          node: process.version,
          root: context.root,
          operations: context.catalog.operations.length,
          catalog: path.join(context.root, "catalog"),
        },
      };
    default:
      return errorResult("GMF-E-USAGE-001", `Unknown command: ${command}`, "Run gmf --help.");
  }
}

const STDIN_TIMEOUT_MS = 500;

// Read the hook payload from stdin. A TTY has no payload, and a pipe that
// never closes is abandoned after STDIN_TIMEOUT_MS so a hook cannot hang.
function readStdin(stream = process.stdin) {
  if (!stream || stream.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", finish);
      stream.off("error", finish);
      stream.pause?.();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk) => chunks.push(Buffer.from(chunk));
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    stream.on("data", onData);
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

function parsePayload(text) {
  if (!text || !text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function runHook(event, env, io) {
  const text = typeof io.stdin === "string" ? io.stdin : await readStdin();
  const payload = parsePayload(text);
  try {
    const result = handleHook(event, payload, {
      workspace: readWorkspace(env.GMF_WORKSPACE || payload.cwd || process.cwd()),
      cwd: env.GMF_WORKSPACE || payload.cwd || process.cwd(),
    });
    if (result.decision === "block") {
      return { exitCode: 0, stdout: `${JSON.stringify({ decision: "block", reason: result.reason || "" })}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: result.stdout || "", stderr: "" };
  } catch (error) {
    // A hook must never fail the host session. A write guard that cannot read
    // the workspace blocks and says why; every other event stays quiet.
    if (event === "pre-write") {
      const reason = `gmf could not read the workspace (${error?.message || error}); fix the file before writing, because the game-folder guard cannot run.`;
      return { exitCode: 0, stdout: `${JSON.stringify({ decision: "block", reason })}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

// gmf mcp: serve the catalog as MCP tools over stdio. With io.stdin as text
// (tests and the docs check) it answers every line and returns the output.
async function runMcp(env, io) {
  const { createMcpServer, serveStdio, serveText } = await import("../mcp/server.mjs");
  const server = createMcpServer({ root: rootFor(env), env, cwd: process.cwd() });
  if (typeof io.stdin === "string") return { exitCode: 0, stdout: await serveText(server, io.stdin), stderr: "" };
  await serveStdio(server);
  return { exitCode: 0, stdout: "", stderr: "" };
}

export async function runCli(argv = [], env = process.env, io = {}) {
  const { command, positionals, flags } = parseArgs(argv);
  if (flags.usageError) {
    const result = errorResult("GMF-E-USAGE-001", flags.usageError, "Pass the value after the flag, or use --flag=value.");
    return { exitCode: exitCodeFor(result), stdout: formatResult(result, { json: flags.json }), stderr: "" };
  }
  if (flags.help || !command) return { exitCode: 0, stdout: helpText(), stderr: "" };
  if (command === "hook") return runHook(positionals[0] || "", env, io);
  if (command === "mcp") return runMcp(env, io);

  let result;
  try {
    result = await dispatch(command, positionals, flags, env);
  } catch (error) {
    result = errorResult(error.code || "GMF-E-EXEC-001", error.message, error.remediation || "");
  }

  return { exitCode: exitCodeFor(result), stdout: formatResult(result, { json: flags.json }), stderr: "" };
}
