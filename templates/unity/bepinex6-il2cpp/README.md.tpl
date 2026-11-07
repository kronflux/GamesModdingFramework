# $(ModName)

A BepInEx 6 IL2CPP plugin scaffolded by GMF for author $(Author).

- Game folder: `$(GameDir)`
- Loader folder: `$(LoaderDir)`
- Interop assemblies: `$(InteropDir)`
- Deploy folder: `$(ModDeployDir)`

Launch the game once with BepInEx 6 IL2CPP installed so the interop assemblies exist,
then build with `gmf run unity.build --input modDir=...` and deploy with
`gmf run unity.deploy --input modDir=... --input gameDir=$(GameDir)`.
