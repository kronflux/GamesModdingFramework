---
name: unity.testing
title: Testing Unity and BepInEx mods
description: Why Unity and BepInEx types cannot be unit-tested, extracting patch logic into pure testable methods, mocking limits, unit and integration test shapes, best practices, coverage goals and what to verify in game.
engine: unity
tags: [testing, nunit, xunit, moq, harmony, unit-tests, integration, mocking, coverage]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Testing Unity and BepInEx mods

Testing with xUnit or NUnit: extracting patch logic into testable pure methods, mocking strategy and its limits, test shapes and best practices. CI without game assemblies: `unity.testing.ci`. For the mod's own verification step use `gmf run unity.validate` (checks every Harmony patch target resolves against the game's assemblies) and `gmf run unity.build`; neither proves in-game behaviour.

## The core constraint

**You cannot unit-test code that touches BepInEx or Unity types.** `BaseUnityPlugin` is a `MonoBehaviour` whose construction needs a live Unity runtime and an initialized BepInEx `Chainloader`; `GameObject`, `Component` and every game type behave the same. Instantiating them under `dotnet test` throws, and no mocking library fixes it: Unity's types are non-virtual and the engine is absent.

```
Plugin class (BaseUnityPlugin)        <- not unit-testable
Harmony patch methods                 <- not unit-testable
   calls
Pure static logic                     <- test THIS
DamageCalculator.Apply(float, float)
ConfigValidator.Clamp(int, int, int)
```

Extract the decision-making from the patch into pure static methods over plain values and test those. The patch becomes a thin adapter verified in game.

## Extract the logic, then test it

```csharp
// Mod assembly, NOT testable: PlayerHealth is a game type; config entries need live BepInEx.
[HarmonyPatch(typeof(PlayerHealth), nameof(PlayerHealth.TakeDamage))]
static class TakeDamagePatch
{
    static bool Prefix(PlayerHealth __instance, ref float damage)
    {
        var result = DamageRules.Evaluate(damage, Plugin.GodModeEnabled.Value, Plugin.DamageMultiplier.Value);
        damage = result.Damage;
        return result.RunOriginal;
    }
}

// Pure: no Unity, no BepInEx, no game types.
public readonly struct DamageResult
{
    public readonly float Damage; public readonly bool RunOriginal;
    public DamageResult(float damage, bool runOriginal) { Damage = damage; RunOriginal = runOriginal; }
}

public static class DamageRules
{
    public static DamageResult Evaluate(float incoming, bool godMode, float multiplier)
        => godMode ? new DamageResult(0f, false) : new DamageResult(incoming * multiplier, true);
}
```

```csharp
[TestFixture]
public class DamageRulesTests
{
    [Test] public void GodMode_ZeroesDamageAndSkipsOriginal()
    {
        var r = DamageRules.Evaluate(50f, godMode: true, multiplier: 1f);
        Assert.That(r.Damage, Is.EqualTo(0f)); Assert.That(r.RunOriginal, Is.False);
    }
    [Test] public void Multiplier_ScalesDamageAndRunsOriginal()
    {
        var r = DamageRules.Evaluate(100f, godMode: false, multiplier: 0.5f);
        Assert.That(r.Damage, Is.EqualTo(50f)); Assert.That(r.RunOriginal, Is.True);
    }
    [TestCase(0f)] [TestCase(-1f)] [TestCase(float.NaN)]
    public void DegenerateInput_DoesNotProduceNaN(float incoming)
        => Assert.That(float.IsNaN(DamageRules.Evaluate(incoming, false, 0.5f).Damage), Is.False);
}
```

The test project references only the logic assembly: no BepInEx, Unity or game DLLs, which is what lets it run in CI.

## Tools

- **NUnit** (primary) or **xUnit** (alternative), assertions from the framework (`NUnit.Framework.Assert`, `Xunit.Assert`). FluentAssertions is optional. There is no BepInEx assertion or test-runner library; `UnityEngine.Assertions.Assert` is for in-game runtime checks, not testing.
- **Moq** is of limited use: it intercepts interfaces and `virtual` members only, not Unity or game types (non-virtual methods, public fields, no parameterless constructors). Use it only for interfaces you define at your own boundaries.

```
dotnet new nunit -n YourMod.Tests
dotnet add reference ../YourMod/YourMod.csproj      # in practice reference the logic project (below)
dotnet add package Moq
dotnet add package FluentAssertions
dotnet test
```

Reference test project: `net6.0`, `NUnit` 3.14, `NUnit3TestAdapter` 4.5, `Microsoft.NET.Test.Sdk` 17.8, optionally `Moq` 4.20 and `FluentAssertions` 6.12, with a `ProjectReference` to the mod (pin to current versions).

Layout: `YourMod/` (`Plugin.cs`, `Patches/`, `Systems/`), `YourMod.Tests/` with `UnitTests/Patches`, `UnitTests/Systems`, `IntegrationTests/`, `PerformanceTests/`, `TestHelpers/` (mocks, fixtures, utilities).

## On mocking

Mocking libraries do **not** rescue Unity types:

- `new Mock<PlayerHealth>()` then `.Setup(x => x.currentHealth)` throws: `currentHealth` is a field, not a virtual property.
- `new Mock<ManualLogSource>()` throws: no parameterless constructor.
- `new Plugin(); plugin.Awake();` throws: `BaseUnityPlugin` needs a live Unity runtime, and `Awake` is `private` in the shipped template.

To fake something, define your own interface at the boundary; the mod supplies a real implementation and tests supply a stub. Do not try to mock the game.

**Inferred.** Common unit-test templates build `Mock<PlayerHealth>` and `Mock<ManualLogSource>`, call the patch's `Prefix(mock.Object, ref damage, ...)` and set `Plugin.DamageMultiplier.Value` directly, and common advice says "mock Unity game objects", with a `Mock<PlayerHealth>` fixture builder. Per the constraint above those examples work only if the game type has virtual members and the config is faked behind your own interface. Treat them as the shape of a test (arrange, act, assert), not as working code against real game types.

## What cannot be unit-tested

Verify in game, through the loader log and manual checks:

- whether a patch actually binds to its target (log `GetPatchedMethods()`; `unity.debugging`)
- plugin lifecycle (`Awake`, `Start`, `OnDestroy`)
- anything touching `GameObject`, `Component` or game types
- config binding through `Config.Bind`
- asset loading

## Test structure and style

- **Arrange, Act, Assert**, with assertion messages. One logical assertion per test (related assertions about one behaviour are fine). Name `MethodName_Scenario_ExpectedBehavior` (`Prefix_WithGodModeEnabled_PreventsDamage`), never `Test1`.
- **Categories** for selection: `Unit`, `Integration`, `Performance`, `Smoke`, plus features and shape (`Prefix`, `Postfix`, `HappyPath`, `EdgeCases`, `NullHandling`, `ErrorHandling`, `Extreme`). Run with `dotnet test --filter "Category=Unit"` or `"Category=Combat|Category=Inventory"`.
- **Fixtures and builders** for shared test data (a `TestFixtures.CreateStandardPlayer()`, a `PlayerHealthBuilder().WithHealth(50f, 100f).Build()`); extract setup, builders, custom assertions and helpers when setup is longer than the test.
- Keep tests fast (unit under 1 second, integration under 10 seconds), independent of each other and of execution order, with no `Thread.Sleep` and no game loads. Refactor when tests are hard to read, copy-pasted, break on implementation details, or have setup longer than the test.
- A test must fail if the code is broken. Test behaviour, not private implementation; do not assert that a mock was called (logging may be removed while behaviour still works); do not mock value types or simple data.
- Performance tests (`[Category("Performance")]`): warm up, then loop 10,000 calls with a `Stopwatch` and assert the average (Update code under 100 microseconds, FixedUpdate under 20), and measure allocation with `GC.GetTotalMemory` after forced collections, allowing a realistic bound (under 5,000 bytes over 10,000 calls).

### What to test

Always: Harmony patch logic (parameter changes, return changes, null handling, zero, negative and extreme values), plugin lifecycle, game-affecting code (health, inventory, economy, save and load), error handling (invalid config, object destroyed mid-processing, exception recovery), hot-path performance. Selectively: UI logic (not rendering), serialization and conflict resolution for networking, asset-loading error handling and caching. Never: Unity engine internals, BepInEx or Harmony themselves, decompiled game code (integration-test your patches against it instead).

Coverage goals (reference): critical Harmony logic over 90 percent, plugin over 80, core systems over 75, utilities over 70, UI over 50, experimental over 30 or 50. A coverage figure over the small testable fraction of a mod is misleading, so skip it until there are tests worth measuring. Measure with `dotnet test --collect:"XPlat Code Coverage"` (coverlet) and ReportGenerator.

When a test fails: read the message, check recent changes (code, config, game version), reproduce in isolation with logging or a debugger, then fix the code, fix a wrong test, or update expectations for an intentional change.

## Integration tests (in-game)

For plugin lifecycle, patches against real game objects, save and load, asset loading and config persistence, use the Unity Test Framework (`com.unity.test-framework`, PlayMode, `[UnityTest]` coroutines) inside an editor project, or in-game verification through the loader log. Shape: a `[SetUp]` that creates the plugin object and a Harmony instance, a `[TearDown]` that destroys created GameObjects and unpatches, and tests that `yield return null` to wait a frame.

Test examples: `Awake` binds config and applies patches (assert `Harmony.GetPatchInfo(AccessTools.Method(type, "TakeDamage"))` has prefixes); `OnDestroy` removes the patches; config saves and reloads (`Config.Save()`, `Config.Reload()`); a damage patch halves damage in game; destruction during processing raises no unexpected log (`LogAssert.NoUnexpectedReceived()`); multiple patches stack in the expected order; 100 damage events fit in one 16 ms frame.

Setup: install the Test Framework through the Package Manager, create a Tests Assembly Folder, run from Window, General, Test Runner (PlayMode) or `Unity -runTests -batchmode -projectPath <path> -testPlatform playmode -testResults results.xml`. Use a dedicated test scene, create objects with real components, and clean up. Do not assume frame timing, leave objects in the scene, change project settings, depend on order or use external services. Use `LogAssert` for log messages, test success and failure paths and realistic conditions. For a coroutine test `yield return new WaitUntil(() => completed)`. Networking and multiplayer tests need a multiplayer environment (`[Ignore]` otherwise).

**Inferred.** Common integration templates call `_plugin.Awake()` and `_plugin.OnDestroy()` on a `Plugin` created with `AddComponent<Plugin>()`. As above, `Awake` is private in the shipped template and a BepInEx plugin needs the Chainloader, so these run only in an environment where BepInEx is actually loaded; a plain Unity Test Framework project does not provide that. Common performance-test snippets that calls a patch with `mockInstance.Object` has the same limitation.

## Test-driven loop

1. Write a failing test for the desired behaviour (against the extracted logic).
2. Write the patch adapter and logic to pass it.
3. Refine and add edge cases.
4. Run tests before every commit and in CI; fail the build when tests fail.
