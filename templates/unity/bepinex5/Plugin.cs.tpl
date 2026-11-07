using BepInEx;
using BepInEx.Logging;
using HarmonyLib;

namespace $(ModName);

[BepInPlugin("$(Guid)", "$(ModName)", "$(Version)")]
public sealed class Plugin : BaseUnityPlugin
{
    internal static ManualLogSource Log = null!;
    private readonly Harmony harmony = new("$(Guid)");

    private void Awake()
    {
        Log = Logger;
        harmony.PatchAll();
        Log.LogInfo("$(ModName) loaded.");
    }
}
