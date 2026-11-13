#include <DynamicOutput/DynamicOutput.hpp>
#include <LuaMadeSimple/LuaMadeSimple.hpp>
#include <Mod/CppUserModBase.hpp>

#include "GmfCommon.hpp"
#include "LuaBindings.hpp"

// The native part of GmfDumper. It supplies the functions the Lua part cannot get from
// UE4SS's Lua API; the Lua part (Scripts/main.lua in the same mod folder) decides what
// runs and when.

namespace GmfDumper
{
    class GmfDumperMod : public CppUserModBase
    {
      public:
        GmfDumperMod() : CppUserModBase()
        {
            ModName = STR("GmfDumper");
            ModVersion = GMFDUMPER_VERSION_W;
            ModDescription = STR("Dumps every reference artifact UE4SS can reach into one folder");
            ModAuthors = STR("kronflux");
        }

        ~GmfDumperMod() override = default;

        auto on_unreal_init() -> void override
        {
            Output::send<LogLevel::Normal>(STR("[GmfDumper] native {} ready\n"), GMFDUMPER_VERSION_W);
        }

        // UE4SS calls this for the Lua mod in the same folder, before that mod's main.lua
        // runs. Globals registered on the main state are visible to the mod's other Lua
        // threads, including the one that runs game-thread callbacks.
        auto on_lua_start(LuaMadeSimple::Lua& lua, LuaMadeSimple::Lua&, LuaMadeSimple::Lua&, LuaMadeSimple::Lua*) -> void override
        {
            register_lua_functions(lua);
        }
    };
} // namespace GmfDumper

extern "C"
{
    __declspec(dllexport) RC::CppUserModBase* start_mod()
    {
        return new GmfDumper::GmfDumperMod();
    }

    __declspec(dllexport) void uninstall_mod(RC::CppUserModBase* mod)
    {
        delete mod;
    }
}
