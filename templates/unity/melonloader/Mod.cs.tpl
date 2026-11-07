using MelonLoader;

[assembly: MelonInfo(typeof($(ModName).Mod), "$(ModName)", "$(Version)", "$(Author)")]
[assembly: MelonGame(null, null)]

namespace $(ModName);

public sealed class Mod : MelonMod
{
    public override void OnInitializeMelon()
    {
        LoggerInstance.Msg("$(ModName) loaded with MelonLoader.");
    }
}
