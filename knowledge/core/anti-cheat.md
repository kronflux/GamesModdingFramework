---
name: core.anti-cheat
title: Anti-cheat mechanisms, mod interactions and ban risk
description: Understand how anti-cheat observes a modded game, why a marker is risk information and what the ban risk depends on.
engine: core
tags: [anti-cheat, ban-risk, safety, online, detection]
confidence: observed
sources: [Public vendor documentation for Easy Anti-Cheat, BattlEye and Riot Vanguard, Public community reports of mod-related bans]
---

# Anti-cheat mechanisms, mod interactions and ban risk

Anti-cheat is risk information, not a gate. The framework records a marker,
emits `GMF-W-ANTICHEAT-001` and proceeds when the plan or the user authorizes
the action. The user owns the game and the machine.

## Mechanisms

- User-mode services and kernel drivers that start before the game.
- Integrity checks over game files and loaded modules.
- Memory scans for known signatures and unexpected executable pages.
- Telemetry and server-side statistics that flag behavior rather than code.
- Crash reporting that includes the loaded module list.

## How mods interact

- A loader such as BepInEx or MelonLoader injects a DLL and adds files to the
  game folder. A file hash or module list check sees that even when the mod
  itself does nothing suspicious.
- Harmony patches modify method bodies in memory. An integrity scan over code
  sections can see the change.
- Asset replacement changes shipped files. A checksum comparison sees it.
- A mod that only runs offline can still be present when the user later joins an
  online session.

## Flagging and ban risk

Detection is not the same as a ban. A ban usually needs a policy decision by the
game operator. Risk rises when:

- the game is online, competitive or has a server-authoritative economy;
- the anti-cheat vendor publishes an explicit no-mod policy;
- the mod alters data the server validates;
- the account has prior flags or the session shares a hardware identifier.

Risk is low for a single-player game with no anti-cheat and no online mode, but a
loader can still break the game or a future update.

## What the framework does

- `detectAntiCheat` records marker IDs and paths in the profile.
- The plan carries the warning and links this note.
- The operation proceeds under the normal soft gate and the acknowledgment is
  recorded in `gmf.plan.json`.
- The framework does not execute an anti-cheat bypass and does not help with
  credential access or piracy.

## Knowledge, not instructions

Understanding what a check observes is useful for judging risk: which files are
hashed, which modules are listed, whether an online session is required. Treat
bypass techniques as context for that risk judgment. Do not enable a bypass in
an online game; the account and the machine belong to the user and a ban is
usually irreversible.
