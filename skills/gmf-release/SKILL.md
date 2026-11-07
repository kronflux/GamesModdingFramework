---
name: gmf-release
description: Package a finished mod locally and verify its contents and license before release.
operations: [unity.package, unreal.package, generic.hash, knowledge.search]
---

# Package a mod locally

Use this when the mod builds, deploys and validates and the user wants a local
package. Publishing to a store is out of scope.

## Steps

1. Confirm the latest validation result belongs to the current build. Rerun it
   if the mod changed after it.
2. Package with the matching engine operation:
   `unity.package` or `unreal.package`. Keep the output under the workspace or
   the path the user names.
3. List the package contents and compare them with the mod folder.
4. Check the contents for game content: no game assembly, no extracted asset,
   no dump and no loader binary.
5. Check the license of every bundled dependency. GPL tools are downloaded at
   runtime and are never part of the package.
6. Record the package path, its hash and the mod version.

Engine skill next: for Unity packaging load unity-bepinex or unity-melonloader;
for Unreal load unreal-pak-blueprint (paks) or unreal-ue4ss-lua (script mods).

## Evidence

Report the package path, the file list, the hash and the validation result that
covers this build.

## Pitfalls

- A package that includes a game file is not distributable. Remove it and fix
  the packaging rule.
- A version in the manifest that differs from the built assembly confuses every
  consumer. Read the version from one source.
- Do not publish automatically. Local packaging is the whole release step.
- A zip that contains a stale DLL passes a file listing and fails at runtime.
  Compare the hash with the build output.
