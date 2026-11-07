---
name: unity.bepinex.lifecycle
title: BepInEx 5 plugin lifecycle and configuration
description: BepInEx 5 plugin attributes, initialization order, dependencies, ConfigEntry configuration and events, logging, inter-plugin communication, safe initialization, debug commands and common patterns.
engine: unity
tags: [bepinex, plugin, lifecycle, config, configentry, logging, awake, dependencies]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# BepInEx 5 plugin lifecycle and configuration

Scope: BepInEx **5 on Mono** games. IL2CPP games need BepInEx 6 (`BasePlugin`, `unity.il2cpp.patching`) or MelonLoader (`unity.melonloader`). BepInEx 6 Mono keeps `BaseUnityPlugin` but moves it to the `BepInEx.Unity.Mono` assembly. Detect loader and backend with `gmf run game.detect`; scaffold with `gmf run unity.scaffold`. Layout and detection: `unity.bepinex`.

**Awake logs but `Update` or `OnGUI` never run:** some games destroy or disable the BepInEx manager object. Set `HideManagerGameObject = true` under `[Chainloader]` in `BepInEx/config/BepInEx.cfg` before changing code. Only a launched game proves the fix; a build does not.

## Essential plugin

```csharp
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;

[BepInPlugin(PluginInfo.PLUGIN_GUID, PluginInfo.PLUGIN_NAME, PluginInfo.PLUGIN_VERSION)]
[BepInProcess("GameName.exe")] // string literal, including the .exe extension
public class Plugin : BaseUnityPlugin
{
    internal static new ManualLogSource Logger { get; private set; }
    internal static ConfigEntry<bool> EnableFeature { get; private set; }

    private void Awake()
    {
        Logger = base.Logger;
        EnableFeature = Config.Bind("General", "EnableFeature", true, "Enable the main feature of this mod");
        Harmony.CreateAndPatchAll(typeof(Plugin));
        Logger.LogInfo($"{PluginInfo.PLUGIN_NAME} {PluginInfo.PLUGIN_VERSION} loaded");
    }
}
```

## Plugin lifecycle

Initialization order: static constructor (if present), plugin constructor, `Awake()` (main initialization), `Start()` (after all plugins loaded), `Update()` every frame (MonoBehaviour), `OnDestroy()` (unloading), `OnApplicationQuit()`.

Dependencies:

```csharp
[BepInDependency("com.otherplugin.guid", BepInDependency.DependencyFlags.HardDependency)]
[BepInDependency("com.optional.plugin", BepInDependency.DependencyFlags.SoftDependency)]
[BepInPlugin(PluginInfo.PLUGIN_GUID, PluginInfo.PLUGIN_NAME, PluginInfo.PLUGIN_VERSION)]
public class Plugin : BaseUnityPlugin
{
    private void Start()
    {
        if (Chainloader.PluginInfos.ContainsKey("com.optional.plugin"))   // optional dependency present
            Logger.LogInfo("Optional plugin found - enabling extra features");
    }
}
```

## Configuration

```csharp
internal static void Initialize(ConfigFile config)
{
    EnableMod = config.Bind("General", "EnableMod", true,
        new ConfigDescription("Enable or disable the mod functionality", null,
            new ConfigurationManagerAttributes { Order = 1 }));
    ModValue = config.Bind("Settings", "ModValue", 1.0f,
        new ConfigDescription("Adjust the mod value", new AcceptableValueRange<float>(0.1f, 10.0f),
            new ConfigurationManagerAttributes { Order = 2 }));
    Hotkey = config.Bind("Controls", "Hotkey", KeyCode.F1,
        new ConfigDescription("Hotkey to toggle mod feature", null,
            new ConfigurationManagerAttributes { Order = 3 }));
}
```

React to changes with `EnableFeature.SettingChanged += (sender, args) => { if (EnableFeature.Value) EnableModFeatures(); else DisableModFeatures(); };`. Group related settings, give descriptions and `AcceptableValueRange`, use `ConfigurationManagerAttributes` for the in-game UI and validate user input before use.

## Logging

Levels: `LogInfo` for milestones, `LogWarning` for recoverable issues, `LogError` for errors (message and stack trace), `LogDebug` for detail (a `#if DEBUG` wrapper keeps it out of release). A small `ModLogger` can prefix `[{PluginInfo.PLUGIN_NAME}]`; structured helpers log method entry and exit (`Entering Name(args)`, `Exiting Name -> result`) and patch application. Triage and log reading: `unity.debugging`, `unity.debugging.logs`.

## Plugin communication

Expose a small static API for other plugins: an `event Action<float> OnModValueChanged`, a `CurrentModValue` property with a private setter, `IsModEnabled()` and `RegisterCallback(Action<float>)`. For multiplayer, detect the networking stack in use (`PhotonNetwork.InRoom`, or `NetworkManager.Singleton.IsConnectedClient` for Unity Netcode) and send through it; do not assume one.

## Error handling

Wrap `Awake` in `try/catch` that logs the message and stack trace, and wrap each stage separately (config, Harmony, components) so the log names the failing stage. Harmony failures may rethrow after logging. For runtime paths use a `SafeExecute(Action, name)` or `SafeExecute<T>(Func<T>, name, default)` wrapper that logs and returns a default. Never let exceptions escape plugin boundaries.

## Performance

Lazy-load and cache resources (`Resources.Load<GameObject>` into a static, logging a failed load); pool frequently created objects with a small `ObjectPool<T>` (a `Queue<T>` with create and reset delegates); avoid allocations in hot paths and profile critical sections (`unity.debugging.performance`).

## Debug commands

**BepInEx has no console-command API.** Its console is a log window, not an interpreter, and core has no `[ConsoleCommand]` attribute. Pick one:

1. **The game's own console API**, if any (Valheim `devcommands`, REPO's `DebugCommandHandler` through REPOLib), usually through a helper mod declared as a `[BepInDependency]`. The most common route; check the game's modding community.
2. **A key binding**, the simplest and needing no console:

```csharp
#if DEBUG
private void Update()
{
    if (Input.GetKeyDown(KeyCode.F9)) { Config.Reload(); Logger.LogInfo("Configuration reloaded"); }
}
#endif
```

3. **Your own attribute plus a reflection scan**: define `ConsoleCommandAttribute`, scan your assembly in `Awake()` for methods carrying it and dispatch by name. You write the interpreter.

For live plugin reloading use **ScriptEngine** from BepInEx.Debug (F6 by default) rather than a command system.

## Best practices

- Structure: separate classes per concern, a short readable `Awake`, dependency injection for complex systems, cleanup in `OnDestroy()`.
- Config: logical groups, clear descriptions and ranges, validated input.
- Errors: log with context, degrade gracefully for non-critical failures.
- Compatibility: check plugin dependencies before use, handle version differences, provide fallbacks for optional features, test with common mod combinations.

## Common patterns

A toggle (`_isEnabled = !_isEnabled`, then enable or disable and log), and a lazily created singleton (`public static X Instance => _instance ??= new X();` with a private constructor and an `Initialize()` method). Plugin classes are `MonoBehaviour`s, so prefer the plugin instance itself over a separate singleton where possible.
