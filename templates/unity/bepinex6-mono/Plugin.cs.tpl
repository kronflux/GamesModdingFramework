using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.Mono;
using HarmonyLib;

namespace $(ModName);

// BepInEx 6 Mono plugins derive from BaseUnityPlugin and start in Awake;
// BasePlugin with Load is the IL2CPP plugin API.
[BepInPlugin("$(Guid)", "$(ModName)", "$(Version)")]
public sealed class Plugin : BaseUnityPlugin
{
    internal static ManualLogSource Log = null!;

    private void Awake()
    {
        Log = Logger;
        // Apply every [HarmonyPatch] class in this assembly.
        new Harmony("$(Guid)").PatchAll(typeof(Plugin).Assembly);
        Log.LogInfo("$(ModName) loaded with BepInEx 6 Mono.");
    }
}
