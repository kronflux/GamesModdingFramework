import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  syncHosts,
  claudeManifests,
  codexManifests,
  hookTables,
  validateSkillReferences,
  discoverSkills,
} from "../src/core/hosts.mjs";
import { repoRoot } from "./helpers/paths.mjs";

const pkg = { name: "gmf", version: "0.1.0", description: "Test package.", license: "MIT" };

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-hosts-"));
  fs.mkdirSync(path.join(root, "skills", "gmf-test"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "gmf-test", "SKILL.md"),
    "---\nname: gmf-test\ndescription: A test skill for host generation.\n---\n\n# Test\n\nRun gmf catalog --json and read the result.\n",
  );
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agents", "gmf-tester.md"),
    "---\nname: gmf-tester\ndescription: A test agent for host generation.\ntools: Read, Bash\n---\n\n# Tester\n\nReturn a summary.\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "gmf", version: "0.1.0", description: "Test package.", license: "MIT" }, null, 2)}\n`,
  );
  return root;
}

test("manifests carry package metadata, skills, agents and hook tables", () => {
  const skills = [{ name: "gmf-test", description: "A test skill.", path: "skills/gmf-test/SKILL.md" }];
  const agents = [{ name: "gmf-tester", description: "A test agent.", path: "agents/gmf-tester.md" }];

  // Claude Code scans ./skills/ and ./agents/ itself and rejects bare names
  // ("must start with ./"), so the manifest lists neither.
  const claude = claudeManifests(pkg, { skills, agents });
  assert.equal(claude.plugin.name, "gmf");
  assert.equal(claude.plugin.version, "0.1.0");
  assert.equal(claude.plugin.skills, undefined);
  assert.equal(claude.plugin.agents, undefined);
  assert.deepEqual(claude.plugin.mcpServers.gmf, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/gmf.mjs", "mcp"] });
  assert.ok(claude.hooks.hooks.PreToolUse.length >= 1);

  // Codex plugins name their skills folder and MCP file by path.
  const codex = codexManifests(pkg, { skills, agents });
  assert.equal(codex.plugin.name, "gmf");
  assert.equal(codex.plugin.skills, "./skills/");
  assert.equal(codex.plugin.mcpServers, "./.codex-plugin/mcp.json");
  assert.deepEqual(codex.mcp.mcpServers.gmf, { command: "node", args: ["./bin/gmf.mjs", "mcp"], cwd: "." });
  assert.ok(codex.hooks.hooks.PostToolUse.length >= 1);

  // Hooks run the plugin's own copy of gmf, which is not on PATH when gmf is
  // installed only as a plugin.
  const hooks = hookTables();
  assert.equal(hooks.claude.hooks.PreToolUse[0].matcher, "Write|Edit");
  assert.equal(hooks.codex.hooks.PreToolUse[0].matcher, "apply_patch");
  assert.equal(hooks.claude.hooks.PostToolUse[0].matcher, "Bash");
  const claudeHook = (event) => hooks.claude.hooks[event][0].hooks[0];
  assert.equal(claudeHook("SessionStart").command, "node");
  assert.deepEqual(claudeHook("SessionStart").args, ["${CLAUDE_PLUGIN_ROOT}/bin/gmf.mjs", "hook", "session-start"]);
  assert.deepEqual(claudeHook("PreToolUse").args.slice(1), ["hook", "pre-write"]);
  assert.deepEqual(claudeHook("PostToolUse").args.slice(1), ["hook", "post-bash"]);
  assert.deepEqual(claudeHook("Stop").args.slice(1), ["hook", "stop"]);
  assert.equal(hooks.codex.hooks.SessionStart[0].hooks[0].command, 'node "${PLUGIN_ROOT}/bin/gmf.mjs" hook session-start');
  assert.equal(hooks.codex.hooks.Stop[0].hooks[0].command, 'node "${PLUGIN_ROOT}/bin/gmf.mjs" hook stop');
});

test("sync writes both host adapters and check is stable afterwards", () => {
  const root = makeRoot();
  try {
    const written = syncHosts({ root });
    assert.equal(written.ok, true);

    const expected = [
      ".agents/plugins/marketplace.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".codex-plugin/plugin.json",
      ".codex-plugin/hooks.json",
      ".codex-plugin/mcp.json",
      ".codex-plugin/agents/gmf-tester.toml",
      "hooks/hooks.json",
    ];
    for (const relative of expected) {
      assert.ok(fs.existsSync(path.join(root, ...relative.split("/"))), `${relative} was not written`);
    }

    const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
    assert.ok(plugin.mcpServers.gmf);

    const codex = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(codex.skills, "./skills/");

    const toml = fs.readFileSync(path.join(root, ".codex-plugin", "agents", "gmf-tester.toml"), "utf8");
    assert.match(toml, /instructions_file = "agents\/gmf-tester\.md"/);

    assert.deepEqual(syncHosts({ root, check: true }), {
      ok: true,
      drift: [],
      files: expected.sort(),
      written: [],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("check fails after a source edit and a host-only skill is rejected", () => {
  const root = makeRoot();
  try {
    syncHosts({ root });
    const agentFile = path.join(root, "agents", "gmf-tester.md");
    const agentText = fs.readFileSync(agentFile, "utf8");
    const changed = agentText.replace(/^description: .*$/m, "description: A changed description.");
    assert.notEqual(changed, agentText, "the fixture agent has a description line");
    fs.writeFileSync(agentFile, changed);

    const drift = syncHosts({ root, check: true });
    assert.equal(drift.ok, false);
    assert.ok(drift.drift.includes(".codex-plugin/agents/gmf-tester.toml"), JSON.stringify(drift.drift));

    const skillFile = path.join(root, "skills", "gmf-test", "SKILL.md");

    fs.writeFileSync(
      skillFile,
      "---\nname: gmf-test\ndescription: Use the Claude Read tool.\n---\n\n# Test\n",
    );
    assert.throws(() => syncHosts({ root }), /host-only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a skill that references a missing operation is rejected", () => {
  const skills = [
    { name: "gmf-test", description: "test", path: "skills/gmf-test/SKILL.md", operations: ["game.detect", "missing.operation"] },
  ];
  const catalog = { version: 1, operations: [{ id: "game.detect" }], knowledge: [{ id: "core.catalog" }] };
  assert.throws(() => validateSkillReferences(skills, catalog), /missing\.operation/);
  assert.equal(
    validateSkillReferences(skills, {
      version: 1,
      operations: [{ id: "game.detect" }, { id: "missing.operation" }],
      knowledge: [],
    }),
    true,
  );
});

test("a skill that references a missing knowledge id is rejected", () => {
  const skills = [{ name: "gmf-test", description: "test", path: "skills/gmf-test/SKILL.md", operations: ["game.detect"], knowledge: ["core.missing"] }];
  const catalog = { version: 1, operations: [{ id: "game.detect" }], knowledge: [{ id: "core.catalog" }] };
  assert.throws(() => validateSkillReferences(skills, catalog), /gmf-test -> core\.missing/);
  assert.equal(
    validateSkillReferences(skills, { version: 1, operations: [{ id: "game.detect" }], knowledge: [{ id: "core.missing" }] }),
    true,
  );
});

test("24 skills are discovered, every engine skill lists knowledge and operations, none exceeds 80 lines", () => {
  const skills = discoverSkills(repoRoot);
  assert.equal(skills.length, 24);
  for (const skill of skills) {
    if (/^(unity|unreal)-/.test(skill.name)) {
      assert.ok(skill.knowledge.length >= 1, `${skill.name} lists no knowledge`);
      assert.ok(skill.operations.length >= 1, `${skill.name} lists no operations`);
    }
    const lines = fs.readFileSync(path.join(repoRoot, skill.path), "utf8").trimEnd().split("\n").length;
    assert.ok(lines <= 80, `${skill.name} has ${lines} lines`);
  }
});

test("the repository skills and agents are generated and host-neutral", () => {
  const result = syncHosts({ root: repoRoot, check: true });
  assert.deepEqual(result.drift, []);

  const skillsDir = path.join(repoRoot, "skills");
  const skillNames = fs.readdirSync(skillsDir).sort();
  assert.equal(skillNames.length, 24);

  const agentsDir = path.join(repoRoot, "agents");
  const agentNames = fs.readdirSync(agentsDir).filter((name) => name.endsWith(".md")).sort();
  assert.equal(agentNames.length, 8);

  for (const name of skillNames) {
    const text = fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /\b(Claude|Codex|Anthropic|OpenAI|TodoWrite|WebSearch|WebFetch)\b/, name);
  }
});

test("the package author becomes the plugin author and marketplace owner", () => {
  const withAuthor = { ...pkg, author: "Example Author <author@example.invalid> (https://example.invalid/author)" };
  const claude = claudeManifests(withAuthor);
  assert.deepEqual(claude.plugin.author, { name: "Example Author", email: "author@example.invalid", url: "https://example.invalid/author" });
  assert.deepEqual(claude.marketplace.owner, { name: "Example Author", email: "author@example.invalid" });
  assert.equal(claude.marketplace.description, withAuthor.description);
  assert.deepEqual(codexManifests(withAuthor).plugin.author, claude.plugin.author);
  assert.equal(claudeManifests(pkg).plugin.author, undefined, "no author field when package.json has none");
});

test("sync writes a Codex marketplace that lists the plugin at the repository root", () => {
  const root = makeRoot();
  try {
    syncHosts({ root });
    const file = path.join(root, ".agents", "plugins", "marketplace.json");
    assert.ok(fs.existsSync(file), "Codex reads local marketplaces from .agents/plugins/marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(marketplace.name, "gmf");
    assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./" });
    assert.equal(marketplace.plugins[0].name, "gmf");
    assert.equal(marketplace.plugins[0].policy.installation, "AVAILABLE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a skill that lists a knowledge id under operations is rejected", () => {
  const catalog = { operations: [{ id: "unity.build" }], knowledge: [{ id: "unity.harmony" }] };
  assert.throws(
    () => validateSkillReferences([{ name: "s", operations: ["unity.harmony"], knowledge: [] }], catalog),
    /s -> unity\.harmony/,
  );
  validateSkillReferences([{ name: "s", operations: ["unity.build"], knowledge: ["unity.harmony"] }], catalog);
});
