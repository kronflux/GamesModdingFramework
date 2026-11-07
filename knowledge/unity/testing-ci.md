---
name: unity.testing.ci
title: CI for Unity mods without game assemblies
description: Why a mod build fails on a CI runner, why game DLLs must never be committed, and the three workable options (BepInEx NuGet feed, split logic project, self-hosted runner) with GitHub Actions workflows and Thunderstore release packaging.
engine: unity
tags: [ci, github-actions, nuget, bepinex, thunderstore, testing, release, melonloader]
confidence: observed
sources: [earlier Unity modding framework notes, nuget.org/packages/LavaGang.MelonLoader (2026-11-07)]
---

# CI for Unity mods

Test strategy: `unity.testing`. Local packaging of a built mod: `gmf run unity.package`.

## The problem

A mod `.csproj` references game assemblies by `HintPath` into a local install (`C:\Steam\steamapps\common\MyGame\MyGame_Data\Managed\Assembly-CSharp.dll`). That path does not exist on a runner, so `dotnet build` on `ubuntu-latest` fails. There is exactly one wrong fix, the obvious one: committing the game DLLs.

## Never commit game assemblies

`Assembly-CSharp.dll`, `UnityEngine*.dll` and anything extracted from the game are **copyrighted game code**. Committing them is copyright infringement regardless of repository visibility, grounds for Thunderstore delisting and a GitHub DMCA takedown, and a later `.gitignore` does not undo it: git history retains them. The same applies to decompiled output. Before the first commit:

```gitignore
decompiled/
DummyDll/
*_Data/
libs/
bin/
obj/
```

## Option 1: BepInEx NuGet feed

BepInEx runs its own feed at `https://nuget.bepinex.dev/` with BepInEx itself plus community **game-specific** libraries. Packages with `GameLibs` in the name hold stripped, publicized game assemblies: reference metadata only, no game logic, redistributable. `nuget.config` at the repo root:

```xml
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="bepinex" value="https://nuget.bepinex.dev/v3/index.json" />
  </packageSources>
</configuration>
```

Replace the `HintPath` references in the `.csproj`:

```xml
<ItemGroup>
  <PackageReference Include="BepInEx.Core" Version="5.*" />
  <PackageReference Include="BepInEx.PluginInfoProps" Version="2.*" PrivateAssets="all" />
  <PackageReference Include="UnityEngine.Modules" Version="2021.3.0" IncludeAssets="compile" />
  <!-- If a GameLibs package exists for your game: <PackageReference Include="MyGame.GameLibs" Version="1.2.3" PrivateAssets="all" /> -->
</ItemGroup>
<ItemGroup Condition="'$(TargetFramework)' == 'net472'">  <!-- no .NET Framework dev pack on the runner -->
  <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />
</ItemGroup>
```

Set `UnityEngine.Modules` to the **game's** Unity version (loader log `Running under Unity v<version>`, or `<Game>_Data/globalgamemanagers`). Project templates live on the same feed: `dotnet new install BepInEx.Templates::2.0.0-be.4 --nuget-source https://nuget.bepinex.dev/v3/index.json`. Cleanest option, but it needs a `GameLibs` package for your game; most games have none.

## Option 2: split the project

Works for any game. Put testable logic in its own project referencing nothing game-specific and build only that in CI:

```
MyMod/
  MyMod.Logic/     pure C#, no Unity or BepInEx refs; CI builds and tests this
  MyMod.Plugin/    patches and plugin class; HintPaths into a local install; built locally only
  MyMod.Tests/     references MyMod.Logic only
```

CI verifies the logic compiles and tests pass; the plugin assembly is built where the game exists. This matches the testing strategy exactly: the only code worth unit-testing has no game dependency. Make the plugin project skip itself when the game is absent:

```xml
<PropertyGroup>
  <GameDir Condition="'$(GameDir)' == ''">$(MSBuildThisFileDirectory)..\..\GameInstall</GameDir>
  <SkipPluginBuild Condition="!Exists('$(GameDir)')">true</SkipPluginBuild>
</PropertyGroup>
```

## Option 3: self-hosted runner

A machine with the game installed, registered as a runner. Full builds and in-game smoke tests become possible and nothing copyrighted leaves your hardware. Worth it only for a large mod with a stable build machine.

## GitHub Actions workflow

```yaml
name: build
on:
  push: { branches: [main] }
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '8.0.x' }
      - run: dotnet restore            # nuget.config supplies the BepInEx feed
      - run: dotnet build --no-restore -c Release
      - run: dotnet test --no-build -c Release --verbosity normal
```

With Option 2 target the projects explicitly (`dotnet build MyMod.Logic/MyMod.Logic.csproj -c Release`, `dotnet test MyMod.Tests/MyMod.Tests.csproj -c Release`). Notes:

- `net472` builds on Linux need `Microsoft.NETFramework.ReferenceAssemblies`; without it use `windows-latest`.
- Pin action majors and update deliberately. The pinned versions (`checkout@v4`, `setup-dotnet@v4`, SDK `8.0.x`) may be out of date; use current majors.
- Skip coverage reporting until there are tests worth measuring.
- A pre-commit hook can run `dotnet test --filter "Category=Unit" --no-build` and abort on failure; pull requests run all tests.

## Release automation

On tag `v*` (with `permissions: contents: write`): build in Release, assemble a Thunderstore package, attach it to the release.

```yaml
      - run: dotnet build -c Release
      - name: Package for Thunderstore
        run: |
          mkdir -p package/plugins
          cp bin/Release/*/MyMod.dll package/plugins/
          cp thunderstore/manifest.json thunderstore/icon.png README.md CHANGELOG.md package/
          cd package && zip -r ../MyMod.zip .
      - uses: softprops/action-gh-release@v2
        with: { files: MyMod.zip }
```

`manifest.json`, `icon.png` and `README.md` must sit at the **zip root** or Thunderstore rejects the upload. Confirm the built zip contains no game assemblies before publishing.

## MelonLoader

MelonLoader publishes the `LavaGang.MelonLoader` package on nuget.org (0.7.3 has net6.0, net472 and net35 targets; checked 2026-11-07), so a CI build can reference the loader API from NuGet. The game's own assemblies are still missing on the runner: use Option 2, build the logic project in CI and build the mod locally against `<game-dir>/MelonLoader/net35/` or `net472/` (Mono) or `net6/` (IL2CPP). (The `MelonLoaderMod` package is an unrelated third-party helper, not the API.)
