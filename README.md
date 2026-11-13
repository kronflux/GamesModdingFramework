# Game Modding Framework (GMF)

GMF is an LLM-first catalog of game modding operations, tools, knowledge, templates and skills. It identifies a game, selects the working toolchain, and exposes every capability as a structured operation an agent can discover and run.

Status: 0.1.0. The catalog has 61 operations, 14 tool registrations, 50 knowledge notes, 11 templates and 25 skills, and every operation is also an MCP tool. The test suite runs on synthetic fixtures. The Unity path (IL2CPP, BepInEx 6) and the Unreal path (UE 5.6, UE4SS, IoStore asset mods) have each been run end to end on a shipped game.

## Ways to use gmf

gmf is one catalog of operations with four ways in. All four run the same
operations through the same executor, gates and evidence.

| Way in | Best for | You get |
|---|---|---|
| Command line | Scripts, any agent that can run commands | Every command, and `gmf run` for any operation |
| MCP server | Claude Desktop, Cursor, any MCP client | Every operation as a tool, every skill as a prompt |
| Claude Code plugin | Claude Code | Skills, agents, hooks, the MCP server and `gmf` on PATH |
| Codex plugin | Codex | Skills, hooks and the MCP server |

Requirements: Node.js 22 or later. No runtime npm dependencies.

### Command line

From a checkout, run `npm link` once to put `gmf` on PATH, or install it
globally from a packed copy:

```bash
npm pack
npm install -g ./gmf-0.1.0.tgz
```

Then, from any folder:

```bash
gmf version --json
gmf games --json
gmf init --game "C:/Games/Some Game" --workspace "C:/mods/SomeGame" --author "You"
gmf investigate --game "C:/Games/Some Game" --json
gmf knowledge search "il2cpp interop" --json
gmf run unity.decompile --input gameDir="C:/Games/Some Game" --input backend=il2cpp --json
```

Without a global install, use `node bin/gmf.mjs` in place of `gmf`.

### MCP server

`gmf mcp` serves the catalog over stdio. Add it to Claude Code or Codex:

```bash
claude mcp add gmf -- node /path/to/gmf/bin/gmf.mjs mcp
codex mcp add gmf -- node /path/to/gmf/bin/gmf.mjs mcp
```

For Claude Desktop, Cursor and other clients, add this to the client's MCP
configuration:

```json
{
  "mcpServers": {
    "gmf": { "command": "node", "args": ["/path/to/gmf/bin/gmf.mjs", "mcp"], "env": { "GMF_WORKSPACE": "/path/to/your/mod/workspace" } }
  }
}
```

- **Tools.** Each operation is a tool named with `_` in place of `.`
  (`unity.remove_mod` is `unity_remove_mod`). Each tool takes the
  operation's inputs and an optional `workspace` folder; without it the server
  uses `GMF_WORKSPACE`, then `CLAUDE_PROJECT_DIR`, then its working folder.
- **Gates.** A tool with a soft gate also takes `authorized` (the effects the
  user approved) and `authorizationSource` (the user's words), like
  `--authorized` and `--source`.
- **Skills and knowledge.** Every skill is an MCP prompt, and the
  `skill_list`, `skill_show`, `knowledge_search` and `knowledge_show` tools
  return skills and notes as text, for clients without plugin skills.
- Results are the CLI's JSON envelope. The server speaks the handshake-based
  MCP versions (2025-11-25 and older).

### Claude Code plugin

The repository is its own Claude Code marketplace. Add it from GitHub, or
from a clone on a local drive (Claude Code refuses marketplaces on network
drives):

```bash
claude plugin marketplace add kronflux/GamesModdingFramework
claude plugin install gmf@gmf
```

From a clone, replace the GitHub name with the clone's path.

To try it for one session without installing: `claude --plugin-dir /path/to/gmf`.
The plugin's hooks run its own `bin/gmf.mjs`, so no global install is needed.

### Codex plugin

The repository is also a Codex marketplace (`.agents/plugins/marketplace.json`):

```bash
codex plugin marketplace add kronflux/GamesModdingFramework
codex plugin add gmf@gmf
```

From a clone, replace the GitHub name with the clone's path.

Codex starts the plugin's MCP server from the installed copy. The custom agents
under `.codex-plugin/agents/` are generated for reference; loading agents from a
Codex plugin is not documented.

## Commands

```
gmf catalog [--engine <id>] [--kind operation|tool|knowledge|template|skill]
gmf games [--root <dir>]
gmf detect --game <dir>
gmf investigate --game <dir> [--workspace <dir>]
gmf init --game <dir> [--workspace <dir>] [--author <name>]
gmf profile
gmf plan draft --goal "<text>" [--out <path>]
gmf plan validate [<plan.json>]
gmf plan apply [<plan.json>] [--authorized <effect> --source <text>]
gmf verify [--plan <path>]
gmf run <operation-id> [--input k=v]... [--authorized <effect> --source <text>]
gmf setup [--engine <id>] [--install --authorized toolInstall --source <text>]
gmf tool list|install|verify [<id>]
gmf knowledge search <query> [--engine <id>] [--tag <tag>]
gmf knowledge show <id>
gmf skill list|show [<name>]
gmf package [--mod <name>] [--out <path>]
gmf status
gmf doctor
gmf hook <event>
gmf mcp
gmf version
```

`gmf apply` is a short form of `gmf plan apply`. Every command accepts `--json` and returns `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message", "remediation" } }`.

## How it works

- **Catalog.** `gmf catalog --json` is the source of truth for every operation, tool, knowledge note, template and skill. Read it before inventing a command.
- **Investigation.** `gmf investigate` detects the engine, version, backend, loader, paths, tools, capabilities, anti-cheat markers and unknowns, and writes an evidence-backed profile. It never writes inside the game folder. A game that is not Unity or Unreal gets engine family hints (Godot, GameMaker, Source, Ren'Py, RPG Maker, CryEngine, Frostbite, Construct, Unity WebGL) with the file that produced each hint.
- **Planning.** `gmf plan draft` turns a goal and the profile into steps with inputs, effects and gates. `gmf plan validate` checks every step; `gmf plan apply` runs them and stops at the first failure unless a step is optional. `gmf verify` runs each step's verify command and records the result in the plan.
- **Analysis.** `unity.decompile` and `unreal.dump` write a normalized dump under `dumps/`, and `analyze.classes`, `analyze.objects`, `analyze.entrypoints`, `analyze.references`, `analyze.assets` and `analyze.strings` read it. `unity.normalize_dump` and `unreal.normalize_dump` rebuild it from an existing decompile or object dump.
- **Workspace.** `gmf init` writes `gmf.json` (committed identity; `"package": { "team": "<Thunderstore team>" }` names packages `Team-Mod-Version.zip`), `gmf.local.json` (machine paths), `AGENTS.md`, `CLAUDE.md`, `.gitignore` and `mods/`. `gmf.profile.json` is generated evidence; `gmf.plan.json` holds the active plan, its authorizations and verification results. `decompiled/`, `extracted/`, `dumps/`, `logs/`, `backups/` and `.gmf/` are ignored.
- **Hooks.** In Claude Code and Codex the generated hooks print the workspace context at session start, block a write into the game folder or into `decompiled/`, `extracted/` or `dumps/`, and remind you to validate a mod you edited.

## Supported engines

- **Unity.** Mono and IL2CPP; BepInEx 5, BepInEx 6 and MelonLoader; decompile, normalize, scaffold (with an example Harmony patch), build, deploy, validate, package, asset extract, inspect and replace, translation workflows.
- **Unreal Engine 4/5.** UE4SS; Lua, C++ and pak scaffolds with drop-in feature and helper modules; a dump helper deployed under a game-write gate, object, usmap and header dumps, normalize, deploy, validate, Lua checks, crash-stack reading, PE analysis and AOB signature emit and verify, package, asset extract, inspect and replace.

## Knowledge and skills

`gmf knowledge search <query>` finds notes by id, title, tags and body; `gmf knowledge show <id>` prints one. The Unreal notes carry field notes, mined gotchas, cookbook recipes, hooking, reflection, signature and dump references; the Unity notes carry Harmony, IL2CPP, C# pattern, debugging, asset, testing and translation material. Each note keeps its verified, observed or inferred label and names its origin in `sources`.

Skills are Agent Skills under `skills/`. The eight `gmf-*` skills cover the workflow; the `unity-*` and `unreal-*` skills route to the knowledge and operations for one subject. `gmf skill list` prints them.

## Authorization

- `auto`: reads and workspace writes run without asking.
- `soft`: game writes, tool installs, network access, game launches, anti-cheat interactions and program runs (`execute`) run when the plan or your instruction authorizes the effect; the source is recorded. An unsatisfied soft gate returns `GMF-E-GATE-001`.
- `hard`: destructive actions, credential access and piracy need explicit approval; piracy and credential access are refused.

Anti-cheat is risk information and knowledge, not a block. A marker produces a warning and a link to the anti-cheat note; the operation proceeds under the normal soft gate. Check the ban risk before using a mod online.

## Safety

- No game content, decompiled code, loader binaries or extracted assets are committed. A pre-commit gate checks the framework repository; the workspace `.gitignore` and the pre-write hook check a mod workspace.
- GPL tools such as AssetRipper are downloaded at runtime, never vendored.
- Back up a file before a game write; `generic.restore` restores a recorded backup.

## Documentation

- [Architecture](docs/architecture.md)
- [Catalog](docs/catalog.md)
- [Authorization](docs/authorization.md)
- [Workflows](docs/workflows.md)
- [Knowledge](docs/knowledge.md)
- [Adding an engine](docs/adding-an-engine.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks every change must pass and how to add an operation, a knowledge note or an engine. Security reports go through [SECURITY.md](SECURITY.md). gmf is MIT licensed.

## Development

```bash
npm test
npm run build-catalog
npm run sync
npm run check
```

`npm run check` fails when the committed catalog or host files are stale, then runs the full test suite; run `npm run build-catalog` and `npm run sync` after a change to regenerate them. Tests use the built-in `node:test` runner and synthetic fixtures; no game content is required. `test/cli-docs.test.mjs` runs every command named in the documentation and fails when one is unknown.
