---
name: unity.debugging.logs
title: Loader log analysis for Unity mods
description: Where BepInEx, MelonLoader and Unity write logs, how to turn logging up, how to read a BepInEx startup, a table of exception signatures and how to log from your own mod.
engine: unity
tags: [logs, bepinex, melonloader, debugging, exceptions, player-log]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Log analysis

Where the logs are, what they mean and how to read them fast. Triage by symptom: `unity.debugging`.

## Log locations

| Loader | File | Notes |
|---|---|---|
| BepInEx 5 | `<game-dir>/BepInEx/LogOutput.log` | Overwritten each launch; copy it before relaunching |
| BepInEx 6 | `<game-dir>/BepInEx/LogOutput.log` | Same |
| MelonLoader | `<game-dir>/MelonLoader/Latest.log` | Previous runs kept alongside, timestamped |
| Unity itself | `%USERPROFILE%/AppData/LocalLow/<Company>/<Game>/Player.log` | Engine-level errors the loader never sees |

When a game fails to start at all, read `Player.log`; the loader log may not exist.

## Turning logging up

BepInEx, `<game-dir>/BepInEx/config/BepInEx.cfg`:

```ini
[Logging.Console]
Enabled = true          # live console window

[Logging.Disk]
WriteUnityLog = true    # fold Unity's own output into LogOutput.log
LogLevel = All          # default hides Debug
```

`WriteUnityLog = true` is the highest-value change; without it engine errors caused by your mod land only in `Player.log`. MelonLoader: launch with `--melonloader.debug` for verbose loader output.

## Reading a BepInEx startup

A healthy startup runs in this order; find the last line that appears and the failure is right after it:

```
[Message:   BepInEx] BepInEx 5.4.23.x - <GameName>
[Info   :   BepInEx] Running under Unity v<version>     <- confirms the Unity version
[Info   :   BepInEx] Chainloader started
[Info   :   BepInEx] 3 plugins to load
[Info   :   BepInEx] Loading [MyMod 1.0.0]              <- your plugin found
[Info   :     MyMod] Mod initialized successfully       <- your own Awake log
[Info   :   BepInEx] Chainloader startup complete
```

- **No BepInEx banner**: the loader never injected. A doorstop problem: check `winhttp.dll` and `doorstop_config.ini` in the game root, and that the game is not launching a different executable than the one you patched.
- **Banner but "0 plugins to load"**: the DLL is in the wrong folder or not a valid plugin. Confirm `BepInEx/plugins/` and `[BepInPlugin]`.
- **"Loading [MyMod]" then an exception**: your `Awake` threw; the stack follows.
- **Loads but your log line never appears**: initialization returned early, or the call is below the configured `LogLevel`.

## Exception signatures

| Log text | Meaning |
|---|---|
| `TypeLoadException` / `Could not resolve type` | Reference mismatch: compiled against a different game version, or a HintPath on the wrong DLL |
| `MissingMethodException` | Method existed at compile time, not runtime. Game updated; re-decompile |
| `Could not load file or assembly 'UnhollowerBaseLib'` | A stale unhollower DLL is referenced; remove it and use the loader's Il2CppInterop |
| `NullReferenceException` in your patch | Usually an unchecked `__instance`, or a destroyed Unity object (fake null) |
| `InvalidProgramException` | Malformed IL from a transpiler: unbalanced stack |
| `AmbiguousMatchException` | Patch target has overloads; supply `argumentTypes` |
| `ObjectCollectedException` | IL2CPP object was garbage-collected; probe `WasCollected` before `.Pointer` |
| `does not have a corresponding IL2CPP class pointer` | Custom MonoBehaviour used without `ClassInjector.RegisterTypeInIl2Cpp<T>()` |
| Harmony patch listed but target absent | Binding failure (`unity.debugging`) |

Mono stack traces are often truncated or mangled. **DemystifyExceptions** from BepInEx.Debug (https://github.com/BepInEx/BepInEx.Debug), installed into `BepInEx/patchers/`, restores readable traces.

## Tools

All from BepInEx.Debug: **DemystifyExceptions** (readable traces), **MirrorInternalLogs** (surfaces hidden loader logging), **StartupProfiler** (per-plugin load timings), **ScriptEngine** (hot-reload plugins from `BepInEx/scripts`, F6, to iterate without restarting). ScriptEngine goes in `plugins/`; the others in `patchers/`. Practice, not a documented API: for long sessions tail the log (`Get-Content LogOutput.log -Wait -Tail 50` in PowerShell, `tail -f` in Git Bash).

## Logging from your own mod

```csharp
Logger.LogInfo("Mod initialized successfully");   // always log a load confirmation
Logger.LogWarning("Config value out of range, using default");
Logger.LogError($"Patch failed: {ex}");           // log the exception object, not ex.Message
Logger.LogDebug("Verbose detail");                // hidden unless LogLevel includes Debug
```

Log the exception **object**: the message alone discards the stack trace and inner exception, usually where the cause is. Prefix user-facing errors with something greppable and specific to your mod so pasted logs are searchable.
