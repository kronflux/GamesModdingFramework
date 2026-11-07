using HarmonyLib;

namespace $(ModName).Patches;

// Example patch on $(TargetType).Log. Target types come from BepInEx/interop and System
// types live under Il2CppSystem. Use Prefix and Postfix only; transpilers do not work on
// interop methods. Parameters can bind by position (__0, __1) when interop parameter
// names differ from the original names. Replace the target type and method with a real
// game method, then run unity.validate to check that they exist in the interop assemblies.
//
// The two attributes combine: the first names the method, the second picks the overload.
[HarmonyPatch(typeof($(TargetType)), "Log")]
[HarmonyPatch(new[] { typeof($(TargetArgType)) })]
internal static class ExamplePatch
{
    internal static int Calls;

    private static void Prefix()
    {
        // Keep patch bodies small and safe: count the call, do not call back into the target.
        Calls++;
    }
}
