#pragma once

namespace RC::LuaMadeSimple
{
    class Lua;
}

namespace GmfDumper
{
    // Registers the GmfDumperNative_* global functions in a Lua state.
    auto register_lua_functions(const RC::LuaMadeSimple::Lua& lua) -> void;
} // namespace GmfDumper
