---
name: unreal.gmfdumper.native
title: The native part of GmfDumper and how it is paired with UE4SS
description: Why GmfDumper has a C++ DLL, how the rolling release is built, how deploy decides whether to install it, and what a run without it still produces.
engine: unreal
tags: [gmfdumper, native, dll, ue4ss, release, workflow, pairing]
confidence: observed
sources: [gmf native/gmfdumper, gmf scripts/build-dumper.mjs, gmf .github/workflows/gmfdumper.yml, local build against RE-UE4SS 4fb9b615 on 2026-11-13]
---

# The native part of GmfDumper

GmfDumper is a UE4SS Lua mod with a C++ part, `Mods/GmfDumper/dlls/main.dll`.
The Lua part orders the steps and writes the manifest. The C++ part does what
Lua cannot: it loads and frees every asset, reads property values through
reflection, reads Blueprint bytecode, and loads maps as data.

## Pairing

The DLL links UE4SS's C++ interface, so one build matches exactly one UE4SS
build. A DLL from another build can crash the game. gmf therefore installs it
only when two records name the same UE4SS release asset:

- `<ue4ss>/gmf-install.json`, written by `unreal.setup_ue4ss`.
- `build.json` inside the downloaded `GmfDumper-native.zip`.

`unreal.deploy_dumper` reports the outcome in `native`:

| Value | Meaning | Next step |
|---|---|---|
| `installed` | The DLL matches and was copied. | Run the dump. |
| `mismatch` | The DLL was built for another UE4SS release. | Run `unreal.setup_ue4ss` to install the latest experimental UE4SS, then deploy again. If UE4SS is already the latest, the build workflow has not caught up; try later. |
| `unknown` | UE4SS was not installed by gmf, so its release is not known. | Run `unreal.setup_ue4ss`. |
| `unavailable` | The download failed. | Check the network and the release `gmfdumper-latest`. |
| `not_authorized` | No `toolInstall` authorization was given. | Ask the user, then deploy again. |

In every case but `installed` the Lua mod is still deployed and any older DLL
is backed up and removed.

## A run without the DLL

The run still produces the UE4SS dumps (object dump, usmap, jmap, headers, Lua
types). The steps that need the DLL are marked skipped in the manifest, and
`gamedocs/README.md` lists the missing sections.

## The build

`.github/workflows/gmfdumper.yml` runs every 6 hours. It reads the latest
`experimental-latest` asset of `UE4SS-RE/RE-UE4SS`, and builds only when that
asset or the tree hash of `native/gmfdumper` differs from `build.json` of the
release `gmfdumper-latest`. It then replaces the two release assets and deletes
its own runs older than 7 days. It needs the secret `UEPSEUDO_TOKEN`, because
every UE4SS build needs the private UEPseudo submodule.

A local build, on Windows with MSVC, CMake, Ninja and Rust:

```bash
node scripts/build-dumper.mjs --ue4ss <RE-UE4SS checkout with submodules> --out dist
```
