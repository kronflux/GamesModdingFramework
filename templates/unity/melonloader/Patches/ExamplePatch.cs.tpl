using HarmonyLib;

namespace $(ModName).Patches;

// Example patch on $(TargetType).Log. Replace the target type (and the method name
// below) with a real game method found in decompiled/, then run unity.validate, which
// checks that the named type and method exist in the game assemblies.
//
// Under IL2CPP the target and argument types are interop types (Il2Cpp-prefixed
// namespaces in MelonLoader 0.6+). Use Prefix and Postfix only; transpilers do not work
// on interop methods.
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
