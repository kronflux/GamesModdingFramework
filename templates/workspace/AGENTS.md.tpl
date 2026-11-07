# {{gameName}} modding workspace

This workspace holds mods for {{gameName}} ({{engine}} engine), maintained by {{author}}. It is managed with GMF, a catalog of modding operations, tools, knowledge and skills.

## Start here

Run `gmf catalog --json` first. The catalog is the contract: it lists every operation with its inputs, outputs, effects and gate. Read it before you invent a command or guess at a flag.

## Workspace files

- `gmf.json` is the committed identity of the project: game name, engine, author and package settings.
- `gmf.local.json` holds machine paths such as the game install folder. It is never committed.
- `gmf.profile.json` is generated evidence about the game: engine, version, backend and loader. Regenerate it instead of editing it. It is never committed.
- `gmf.plan.json` is the current plan and its authorizations. It is never committed.

The workspace is separate from the game install. Do not write into the game folder unless a plan step authorizes it.

## Skills

Eight core skills cover the work, and each names the operations it uses.

- `gmf-investigate` finds out what the game is and how it is built.
- `gmf-plan` turns a goal into ordered, gated steps.
- `gmf-implement` writes the mod.
- `gmf-debug` finds the cause of a crash or a wrong behaviour.
- `gmf-verify` checks a build before it is trusted.
- `gmf-release` packages a finished mod locally.
- `gmf-contribute` returns what you learned to the shared knowledge.
- `gmf-safety` explains gates, risk and what needs the user's say.

Engine skills are named `unity-*` and `unreal-*`. List them from the catalog and load the ones that match `{{engine}}`.

## Layout

- Each mod lives under `mods/<name>/`.
- `decompiled/`, `extracted/`, `dumps/`, `logs/`, `backups/` and `.gmf/` are working folders. They are ignored by git.

## Never commit

Never commit game content, decompiled code, loader binaries or extracted assets. The ignore rules cover the working folders, but check what you stage. If a file came from the game or from a tool's download, it stays out of the repository.
