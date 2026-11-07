using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using HarmonyLib;

namespace $(ModName);

[BepInPlugin("$(Guid)", "$(ModName)", "$(Version)")]
public sealed class Plugin : BasePlugin
{
    // BasePlugin already has an instance Log; this static one lets patches log too.
    internal static new ManualLogSource Log = null!;

    public override void Load()
    {
        Log = base.Log;
        // Apply every [HarmonyPatch] class in this assembly.
        new Harmony("$(Guid)").PatchAll(typeof(Plugin).Assembly);
        Log.LogInfo("$(ModName) loaded with BepInEx 6 IL2CPP.");
    }
}
