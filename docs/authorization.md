# Authorization and gates

Every operation declares effects. The framework maps the effects to a gate:

- `auto`: `read`, `workspaceWrite`. Runs without asking.
- `soft`: `gameWrite`, `toolInstall`, `network`, `launchGame`, `antiCheat`, `execute` (running a program such as a registered tool with caller-chosen arguments). Runs when the active plan or the user's instruction authorizes the effect; the source is recorded. Otherwise the executor refuses with `GMF-E-GATE-001`.
- `hard`: `destructive`, `credentials`, `piracy`. The model cannot override. The user approves the exact operation and target; some actions are refused.

## Soft gates

A plan can carry authorizations:

```json
{
  "authorizations": [
    { "effect": "toolInstall", "source": "user: install BepInEx", "scope": "step:2" }
  ]
}
```

The model may also pass `--authorized <effect>[,<effect>] --source "<quoted instruction or plan step>"` when the user's current instruction or the approved plan contains the action. The run records the effect, gate and source.

Every soft effect an operation declares needs its own authorization, and a `--authorized` flag counts only together with `--source`. `unreal.setup_ue4ss` declares `toolInstall`, `network` and `gameWrite`, so a `toolInstall` authorization alone is refused and the error names the missing effect. One implication is built in: a `toolInstall` authorization covers `network`, because installing a tool is a download. Nothing covers `gameWrite`.

The executor checks the gate before every handler, reading an explicit plan, else the workspace's `gmf.plan.json`, plus the `--authorized` flags. Handlers that check again use the same reader, so an authorization recorded in the plan file is enough everywhere.

## Hard gates and anti-cheat

Hard gates cover destructive actions, credential access and piracy. They require explicit user approval for the exact operation and target. A model-supplied source cannot satisfy a hard gate.

Anti-cheat is different. A marker in the game profile produces a `GMF-W-ANTICHEAT-001` warning and a link to the anti-cheat knowledge. It does not block an operation. The framework records the acknowledgment and proceeds under the normal soft gate. Know what a game's anti-cheat does, how a mod might interact with it, and what the ban risk is before you enable a mod in an online game.

## Backups

Before a `gameWrite` operation overwrites an existing file, the operation copies the original into the workspace `backups/` folder and records its SHA-256. `generic.restore` restores a recorded backup. A write that cannot be backed up is refused with `GMF-E-GATE-001`. `unreal.deploy_dumper` follows the same rule: it backs up `UE4SS-settings.ini` before merging the dump keys.

## Tool installs

`tool.install`, `gmf tool install <id>` and `gmf setup --install` need a `toolInstall` authorization from the plan or `--authorized toolInstall --source "<instruction>"`. Tools marked user-provided (dotnet, ilspycmd, python) are never downloaded; `gmf tool list` shows whether they resolve on `PATH`.

## Error and warning codes

- `GMF-E-GATE-001`: an authorization is required.
- `GMF-E-POLICY-001`: a hard-gated action was refused.
- `GMF-W-ANTICHEAT-001`: an anti-cheat risk warning.
- `GMF-E-TOOL-001`: a required tool is missing.
- `GMF-E-PLAN-001`: an invalid plan or operation.
- `GMF-E-GAME-001`: an invalid game path.
- `GMF-E-TEMPLATE-001`: an unknown template, feature or helper name.
- `GMF-E-DUMP-001`: a normalized dump carries a reserved key such as a method body.
- `GMF-E-SIG-001`: a signature matches more than once or not at all; `GMF-E-SIG-002`: an instruction the length decoder does not know.
- `GMF-E-BACKUP-001`: no recorded backup for the target, or a backup path that is not in the manifest or not under `backups/`; `GMF-E-BACKUP-002`: a backup whose hash no longer matches its record; `GMF-E-BACKUP-003`: a backup that belongs to another file.
- `GMF-E-WORKSPACE-001`: an operation that needs a workspace was run without one.
- `GMF-E-FILE-001`: a file argument is not a file; `GMF-E-FILE-002`: a JSON file exists but cannot be read or parsed, and gmf refuses to replace it.
- `GMF-E-USAGE-001`: an unknown command or a missing argument.
