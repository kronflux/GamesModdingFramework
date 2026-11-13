#include "LuaBindings.hpp"

#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <DynamicOutput/DynamicOutput.hpp>
#include <LuaMadeSimple/LuaMadeSimple.hpp>
#include <UE4SSProgram.hpp>

// The functions the Lua part calls. Each is registered as a global named
// GmfDumperNative_<Name>; gmfdumper/app.lua collects them into one table.
//
// Results follow one convention: a true value on success, or nil and a message. No
// function lets a C++ exception reach Lua.

namespace GmfDumper
{
    using Lua = LuaMadeSimple::Lua;

    namespace
    {
        auto fail(const Lua& lua, const std::string& message) -> int
        {
            lua.set_nil();
            lua.set_string(message);
            return 2;
        }

        // Reads the next string argument. Arguments are consumed in order.
        auto next_string(const Lua& lua, const char* what) -> std::string
        {
            if (!lua.is_string())
            {
                throw std::runtime_error{std::string{"expected a string argument: "} + what};
            }
            return std::string{lua.get_string()};
        }

        // Runs `body` and returns true to Lua, or nil and the exception text.
        template <typename Body>
        auto guarded(const Lua& lua, Body&& body) -> int
        {
            try
            {
                body();
            }
            catch (const std::exception& e)
            {
                return fail(lua, e.what());
            }
            catch (...)
            {
                return fail(lua, "unknown native error");
            }
            lua.set_bool(true);
            return 1;
        }

        // Like guarded, for a function that returns a string to Lua.
        template <typename Body>
        auto guarded_string(const Lua& lua, Body&& body) -> int
        {
            std::string result{};
            try
            {
                result = body();
            }
            catch (const std::exception& e)
            {
                return fail(lua, e.what());
            }
            catch (...)
            {
                return fail(lua, "unknown native error");
            }
            lua.set_string(result);
            return 1;
        }

        // A dumper that takes one path argument.
        template <typename Dumper>
        auto path_call(const Lua& lua, const char* what, Dumper&& dumper) -> int
        {
            return guarded(lua, [&] {
                dumper(to_path(next_string(lua, what)));
            });
        }

        auto build_info() -> std::string
        {
            std::string info = std::to_string(UE4SS_LIB_VERSION_MAJOR) + "." + std::to_string(UE4SS_LIB_VERSION_MINOR) + "." +
                               std::to_string(UE4SS_LIB_VERSION_HOTFIX);
            if (UE4SS_LIB_VERSION_PRERELEASE != 0)
            {
                info += " PreRelease #" + std::to_string(UE4SS_LIB_VERSION_PRERELEASE);
            }
            if (UE4SS_LIB_BETA_STARTED != 0)
            {
                info += " Experimental";
            }
            info += " ";
            info += UE4SS_LIB_BUILD_GITSHA;
            return info;
        }
    } // namespace

    auto register_lua_functions(const Lua& lua) -> void
    {
        lua.register_function("GmfDumperNative_Version", [](const Lua& lua) -> int {
            lua.set_string(GMFDUMPER_VERSION);
            return 1;
        });

        // The UE4SS version this DLL was built against, which is the version it expects.
        lua.register_function("GmfDumperNative_BuildInfo", [](const Lua& lua) -> int {
            return guarded_string(lua, [] {
                return build_info();
            });
        });

        lua.register_function("GmfDumperNative_WorkingDir", [](const Lua& lua) -> int {
            return guarded_string(lua, [] {
                return to_utf8_string(UE4SSProgram::get_program().get_working_directory());
            });
        });

        lua.register_function("GmfDumperNative_MapName", [](const Lua& lua) -> int {
            return guarded_string(lua, [] {
                return current_map_name();
            });
        });

        // --- files

        lua.register_function("GmfDumperNative_MakeDirs", [](const Lua& lua) -> int {
            return path_call(lua, "path", fs_make_dirs);
        });

        lua.register_function("GmfDumperNative_Move", [](const Lua& lua) -> int {
            return guarded(lua, [&] {
                auto from = to_path(next_string(lua, "from"));
                auto to = to_path(next_string(lua, "to"));
                fs_move(from, to);
            });
        });

        lua.register_function("GmfDumperNative_ListDir", [](const Lua& lua) -> int {
            return guarded_string(lua, [&] {
                return fs_list_dir(to_path(next_string(lua, "path")));
            });
        });

        lua.register_function("GmfDumperNative_FileSize", [](const Lua& lua) -> int {
            int64_t size{-1};
            try
            {
                size = fs_file_size(to_path(next_string(lua, "path")));
            }
            catch (const std::exception& e)
            {
                return fail(lua, e.what());
            }
            if (size < 0)
            {
                return fail(lua, "not a file");
            }
            lua.set_integer(size);
            return 1;
        });

        // Returns true or false; never nil, so Lua can tell "no" from "failed".
        lua.register_function("GmfDumperNative_IsDir", [](const Lua& lua) -> int {
            bool is_dir{};
            try
            {
                is_dir = fs_is_dir(to_path(next_string(lua, "path")));
            }
            catch (...)
            {
            }
            lua.set_bool(is_dir);
            return 1;
        });

        lua.register_function("GmfDumperNative_TreeStats", [](const Lua& lua) -> int {
            return guarded_string(lua, [&] {
                return fs_tree_stats(to_path(next_string(lua, "path")));
            });
        });

        // --- assets

        lua.register_function("GmfDumperNative_LoadAllAssets", [](const Lua& lua) -> int {
            return guarded(lua, [&] {
                auto mode = next_string(lua, "mode");
                if (!lua.is_integer())
                {
                    throw std::runtime_error{"expected an integer argument: megabytes of memory to keep free"};
                }
                auto min_free_mb = lua.get_integer();
                load_all_assets(mode, min_free_mb < 0 ? 0 : static_cast<uint64_t>(min_free_mb));
            });
        });

        lua.register_function("GmfDumperNative_FreeAllAssets", [](const Lua& lua) -> int {
            return guarded(lua, [] {
                free_all_assets();
            });
        });

        // Number of assets still pinned. Never fails.
        lua.register_function("GmfDumperNative_HeldAssets", [](const Lua& lua) -> int {
            lua.set_integer(static_cast<int64_t>(held_asset_count()));
            return 1;
        });

        lua.register_function("GmfDumperNative_ListMaps", [](const Lua& lua) -> int {
            return guarded_string(lua, [] {
                return list_maps();
            });
        });

        lua.register_function("GmfDumperNative_ListLoadedMaps", [](const Lua& lua) -> int {
            return guarded_string(lua, [] {
                return list_loaded_maps();
            });
        });

        // (package, dir, megabytes to keep free) -> number of actors as text
        lua.register_function("GmfDumperNative_DumpLevel", [](const Lua& lua) -> int {
            return guarded_string(lua, [&] {
                auto package = next_string(lua, "package");
                auto dir = to_path(next_string(lua, "dir"));
                if (!lua.is_integer())
                {
                    throw std::runtime_error{"expected an integer argument: megabytes of memory to keep free"};
                }
                auto min_free_mb = lua.get_integer();
                return std::to_string(dump_level(package, dir, min_free_mb < 0 ? 0 : static_cast<uint64_t>(min_free_mb)));
            });
        });

        lua.register_function("GmfDumperNative_DumpAssetRegistry", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_asset_registry);
        });

        // --- UE4SS's own generators, called with a chosen output path

        lua.register_function("GmfDumperNative_DumpObjects", [](const Lua& lua) -> int {
            return guarded(lua, [&] {
                auto file = to_path(next_string(lua, "file"));
                if (file.has_parent_path())
                {
                    fs_make_dirs(file.parent_path());
                }
                UE4SSProgram::dump_all_objects_and_properties(file.wstring());
            });
        });

        lua.register_function("GmfDumperNative_GenerateCXX", [](const Lua& lua) -> int {
            return guarded(lua, [&] {
                auto dir = to_path(next_string(lua, "dir"));
                fs_make_dirs(dir);
                UE4SSProgram::get_program().generate_cxx_headers(dir);
            });
        });

        lua.register_function("GmfDumperNative_GenerateLuaTypes", [](const Lua& lua) -> int {
            return guarded(lua, [&] {
                auto dir = to_path(next_string(lua, "dir"));
                fs_make_dirs(dir);
                UE4SSProgram::get_program().generate_lua_types(dir);
            });
        });

        lua.register_function("GmfDumperNative_GenerateBPSDK", [](const Lua& lua) -> int {
            return guarded(lua, [&] {
                auto dir = to_path(next_string(lua, "dir"));
                auto backend = next_string(lua, "backend");
                generate_bp_sdk(dir, backend);
            });
        });

        // --- this mod's own dumps

        lua.register_function("GmfDumperNative_GenerateTMapOverrides", [](const Lua& lua) -> int {
            return path_call(lua, "dir", generate_tmap_overrides);
        });

        lua.register_function("GmfDumperNative_DumpReflection", [](const Lua& lua) -> int {
            return path_call(lua, "dir", dump_reflection);
        });

        lua.register_function("GmfDumperNative_DumpHooks", [](const Lua& lua) -> int {
            return path_call(lua, "dir", dump_hooks);
        });

        lua.register_function("GmfDumperNative_DumpNames", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_names);
        });

        lua.register_function("GmfDumperNative_DumpScripts", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_scripts);
        });

        lua.register_function("GmfDumperNative_DumpActors", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_actors);
        });

        lua.register_function("GmfDumperNative_DumpRuntime", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_runtime_context);
        });

        lua.register_function("GmfDumperNative_DumpDataTables", [](const Lua& lua) -> int {
            return path_call(lua, "dir", dump_data_tables);
        });

        lua.register_function("GmfDumperNative_DumpDataAssets", [](const Lua& lua) -> int {
            return path_call(lua, "dir", dump_data_assets);
        });

        lua.register_function("GmfDumperNative_DumpConfigObjects", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_config_objects);
        });

        lua.register_function("GmfDumperNative_DumpWidgetTrees", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_widget_trees);
        });

        lua.register_function("GmfDumperNative_DumpGameplayTags", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_gameplay_tags);
        });

        lua.register_function("GmfDumperNative_DumpAssetValues", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_asset_values);
        });

        lua.register_function("GmfDumperNative_DumpClassDefaults", [](const Lua& lua) -> int {
            return path_call(lua, "file", dump_class_defaults);
        });

        lua.register_function("GmfDumperNative_DumpWorldValues", [](const Lua& lua) -> int {
            return guarded(lua, [&] {
                dump_world_values(to_path(next_string(lua, "file")));
            });
        });

        // Last resort for closing the game after an automatic run. Does not return.
        lua.register_function("GmfDumperNative_EndProcess", [](const Lua& lua) -> int {
            end_process();
            lua.set_bool(true);
            return 1;
        });

        lua.register_function("GmfDumperNative_ExeInfo", [](const Lua& lua) -> int {
            return guarded_string(lua, [] {
                return game_exe_info();
            });
        });
    }
} // namespace GmfDumper
