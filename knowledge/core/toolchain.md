---
name: core.toolchain
title: Tool registry, cache and runtime downloads
description: Resolve tools from the registry cache and install only with authorization and a recorded verification outcome.
engine: core
tags: [tools, toolchain, licenses, downloads, verification]
confidence: verified
sources: [GMF design documentation (docs/architecture.md, docs/catalog.md, docs/authorization.md), BepInEx LGPL-2.1 license, Cpp2IL MIT license]
---

# Tool registry, cache and runtime downloads

The framework registers and invokes external tools. It does not reimplement
loaders, decompilers or asset parsers.

## Lifecycle

1. A tool entry in `catalog/tools.json` names the source, version policy, asset
   pattern, entry point, verification and effects.
2. `tool.install` resolves the release, downloads the asset and extracts it into
   the machine tool cache. The cache is outside the repository.
3. The installer records the resolved version, the path, the verification
   outcome and the source in the cache manifest.
4. `tool.verify` rechecks an installed tool. `resolveTool` returns null when the
   cached path no longer exists, so a game or tool update invalidates it.

## Licenses

GPL tools such as AssetRipper, FModel, Vortex and Reloaded-II are downloaded at
runtime and never vendored. BepInEx is LGPL-2.1, MelonLoader is Apache-2.0,
UE4SS, retoc, repak and UAssetGUI are MIT or Apache-2.0. Record the license with the tool.

## Authorization

An install has `toolInstall` and usually `network` effects, so it is soft gated.
The plan must contain a `tool.install` step or the user must authorize the
effect. If the source publishes no hash and no size, the install is allowed only
with a soft authorization and the limitation is recorded.

## Pitfalls

- A missing tool is `GMF-E-TOOL-001`, not a prompt to download something.
- Do not copy a tool binary into the repository to make a test pass.
- Do not trust a release asset by name alone when a hash is available.
