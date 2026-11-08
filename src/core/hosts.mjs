import fs from "node:fs";
import path from "node:path";

const HOST_ONLY_PATTERNS = [
  { label: "Claude", regex: /\bClaude\b/i },
  { label: "Codex", regex: /\bCodex\b/i },
  { label: "Anthropic", regex: /\bAnthropic\b/i },
  { label: "OpenAI", regex: /\bOpenAI\b/i },
  { label: "TodoWrite", regex: /\bTodoWrite\b/ },
  { label: "WebSearch", regex: /\bWebSearch\b/ },
  { label: "WebFetch", regex: /\bWebFetch\b/ },
  { label: "a host directory", regex: /(?:^|[\\/])\.(?:claude|codex)[\\/]/i },
];

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {}, body: text.trim() };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!entry) continue;
    const raw = entry[2].trim();
    data[entry[1]] =
      raw.startsWith("[") && raw.endsWith("]")
        ? raw
            .slice(1, -1)
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : raw;
  }
  return { data, body: text.slice(match[0].length).trim() };
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function listFiles(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertHostNeutral(text, source) {
  const found = HOST_ONLY_PATTERNS.filter((pattern) => pattern.regex.test(text)).map((pattern) => pattern.label);
  if (found.length > 0) {
    throw new Error(`Skill ${source} names a host-only tool or path: ${[...new Set(found)].join(", ")}`);
  }
  return true;
}

export function discoverSkills(root = process.cwd()) {
  const dir = path.join(root, "skills");
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    assertHostNeutral(text, toPosix(path.relative(root, file)));
    const { data } = parseFrontmatter(text);
    const name = data.name || entry.name;
    const description = data.description || "";
    if (!name || !description) throw new Error(`Skill ${file} needs a name and a description in its frontmatter`);
    skills.push({
      name,
      description,
      path: toPosix(path.relative(root, file)),
      operations: Array.isArray(data.operations) ? data.operations : [],
      knowledge: Array.isArray(data.knowledge) ? data.knowledge : [],
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return skills;
}

export function discoverAgents(root = process.cwd()) {
  const dir = path.join(root, "agents");
  const agents = [];
  for (const file of listFiles(dir, ".md")) {
    const { data } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name = data.name || path.basename(file, ".md");
    const description = data.description || "";
    if (!name || !description) throw new Error(`Agent ${file} needs a name and a description in its frontmatter`);
    agents.push({ name, description, path: toPosix(path.relative(root, file)) });
  }
  agents.sort((left, right) => left.name.localeCompare(right.name));
  return agents;
}

// Check that every operation and knowledge ID a skill names exists in the
// catalog. The catalog build calls this so a skill cannot reference a
// capability or a note that has no entry.
export function validateSkillReferences(skills, catalog) {
  const operations = new Set(((catalog && catalog.operations) || []).map((operation) => operation.id));
  const knowledge = new Set(((catalog && catalog.knowledge) || []).map((entry) => entry.id));
  const missing = [];
  for (const skill of skills) {
    for (const id of skill.operations || []) {
      if (!operations.has(id)) missing.push({ skill: skill.name, id });
    }
    for (const id of skill.knowledge || []) {
      if (!knowledge.has(id)) missing.push({ skill: skill.name, id });
    }
  }
  if (missing.length > 0) {
    const summary = missing.map((entry) => `${entry.skill} -> ${entry.id}`).join(", ");
    throw new Error(`Skill references a missing operation or knowledge ID: ${summary}`);
  }
  return true;
}

// Hooks run the plugin's own copy of gmf: a plugin install does not put gmf on
// PATH. Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} in exec-form args; Codex
// exports PLUGIN_ROOT to the hook's shell.
const HOOK_EVENTS = [
  ["SessionStart", null, "session-start"],
  ["PreToolUse", { claude: "Write|Edit", codex: "apply_patch" }, "pre-write"],
  ["PostToolUse", { claude: "Bash", codex: "Bash" }, "post-bash"],
  ["Stop", null, "stop"],
];

export function hookTables() {
  const claude = {};
  const codex = {};
  for (const [event, matcher, name] of HOOK_EVENTS) {
    const claudeHook = { type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/gmf.mjs", "hook", name], timeout: 10 };
    const codexHook = { type: "command", command: `node "${"${PLUGIN_ROOT}"}/bin/gmf.mjs" hook ${name}` };
    claude[event] = [matcher ? { matcher: matcher.claude, hooks: [claudeHook] } : { hooks: [claudeHook] }];
    codex[event] = [matcher ? { matcher: matcher.codex, hooks: [codexHook] } : { hooks: [codexHook] }];
  }
  return { claude: { hooks: claude }, codex: { hooks: codex } };
}

// package.json "author" ("Name <email> (url)" or an object) as { name, email, url }.
export function parseAuthor(author) {
  if (!author) return null;
  if (typeof author === "object") {
    const parsed = { name: author.name, email: author.email, url: author.url };
    for (const key of Object.keys(parsed)) if (!parsed[key]) delete parsed[key];
    return parsed.name ? parsed : null;
  }
  const match = String(author).match(/^\s*([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?\s*$/);
  if (!match) return null;
  const parsed = { name: match[1] };
  if (match[2]) parsed.email = match[2];
  if (match[3]) parsed.url = match[3];
  return parsed;
}

// Claude Code finds ./skills/, ./agents/ and ./hooks/hooks.json by itself and
// rejects bare names in skills and agents, so the manifest lists none of them.
// options.icon: a path inside the plugin, such as "./logo.png", listed in the
// manifest for Anthropic's plugin directory when the file exists.
export function claudeManifests(pkg, options = {}) {
  const author = parseAuthor(pkg.author);
  return {
    plugin: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      ...(author ? { author } : {}),
      license: pkg.license || "MIT",
      ...(options.icon ? { icon: options.icon } : {}),
      mcpServers: {
        gmf: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/gmf.mjs", "mcp"] },
      },
    },
    marketplace: {
      name: pkg.name,
      description: pkg.description,
      owner: author ? { name: author.name, ...(author.email ? { email: author.email } : {}) } : { name: pkg.name },
      plugins: [
        {
          name: pkg.name,
          source: "./",
          description: pkg.description,
          version: pkg.version,
        },
      ],
    },
    hooks: hookTables().claude,
  };
}

// Codex plugins point at their skills folder, hooks file and MCP file by path;
// MCP args are relative to the plugin folder through cwd ".".
export function codexManifests(pkg) {
  const author = parseAuthor(pkg.author);
  return {
    plugin: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      ...(author ? { author } : {}),
      license: pkg.license || "MIT",
      skills: "./skills/",
      hooks: "./.codex-plugin/hooks.json",
      mcpServers: "./.codex-plugin/mcp.json",
      interface: {
        displayName: "GMF",
        shortDescription: "Investigate, mod, build and deploy Unity and Unreal games",
        category: "Developer Tools",
      },
    },
    hooks: hookTables().codex,
    mcp: { mcpServers: { gmf: { command: "node", args: ["./bin/gmf.mjs", "mcp"], cwd: "." } } },
    // `codex plugin marketplace add <repo>` reads .agents/plugins/marketplace.json.
    marketplace: {
      name: pkg.name,
      interface: { displayName: "GMF" },
      plugins: [
        {
          name: pkg.name,
          source: { source: "local", path: "./" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ],
    },
  };
}

function renderAgentToml(agent) {
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `instructions_file = ${JSON.stringify(agent.path)}`,
    "",
  ].join("\n");
}

function readPackage(root) {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) throw new Error(`Host generation needs package.json at ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["name", "version", "description"]) {
    if (typeof data[key] !== "string" || !data[key].trim()) {
      throw new Error(`package.json needs a non-empty ${key} for host generation`);
    }
  }
  return data;
}

function expectedFiles(root, pkg) {
  const skills = discoverSkills(root);
  const agents = discoverAgents(root);
  const claude = claudeManifests(pkg, { icon: fs.existsSync(path.join(root, "logo.png")) ? "./logo.png" : null });
  const codex = codexManifests(pkg);

  const files = new Map([
    [".claude-plugin/plugin.json", renderJson(claude.plugin)],
    [".claude-plugin/marketplace.json", renderJson(claude.marketplace)],
    ["hooks/hooks.json", renderJson(claude.hooks)],
    [".codex-plugin/plugin.json", renderJson(codex.plugin)],
    [".codex-plugin/hooks.json", renderJson(codex.hooks)],
    [".codex-plugin/mcp.json", renderJson(codex.mcp)],
    [".agents/plugins/marketplace.json", renderJson(codex.marketplace)],
  ]);
  for (const agent of agents) {
    files.set(`.codex-plugin/agents/${agent.name}.toml`, renderAgentToml(agent));
  }
  return { files, skills, agents };
}

function existingAgentTomls(root) {
  const dir = path.join(root, ".codex-plugin", "agents");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => `.codex-plugin/agents/${entry.name}`)
    .sort();
}

// Generate the Claude Code and Codex adapters from the one skills and agents
// source tree. In check mode nothing is written; the returned drift lists every
// file whose content or presence differs.
export function syncHosts({ root = process.cwd(), check = false, catalog = null } = {}) {
  const pkg = readPackage(root);
  if (catalog) validateSkillReferences(discoverSkills(root), catalog);
  const { files } = expectedFiles(root, pkg);

  const drift = [];
  for (const [relative, content] of files) {
    const target = path.join(root, ...relative.split("/"));
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current !== content) drift.push(relative);
  }
  for (const relative of existingAgentTomls(root)) {
    if (!files.has(relative)) drift.push(relative);
  }
  drift.sort();

  if (check) {
    return { ok: drift.length === 0, drift, files: [...files.keys()].sort(), written: [] };
  }

  const written = [];
  for (const [relative, content] of files) {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(relative);
  }
  for (const relative of existingAgentTomls(root)) {
    if (!files.has(relative)) fs.rmSync(path.join(root, ...relative.split("/")), { force: true });
  }
  return { ok: true, drift: [], files: [...files.keys()].sort(), written: written.sort() };
}
