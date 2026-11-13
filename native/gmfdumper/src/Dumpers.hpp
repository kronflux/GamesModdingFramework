#pragma once

// The native dump functions. Each writes its output and throws std::exception on failure;
// LuaBindings.cpp turns that into the nil-and-message result Lua expects.
// All of them must be called on the game thread.

#include <cstdint>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

namespace RC::Unreal
{
    class UObject;
}

namespace GmfDumper
{
    // --- Fs.cpp
    auto fs_make_dirs(const std::filesystem::path& path) -> void;
    // Moves a file or folder, replacing an existing file at the target.
    auto fs_move(const std::filesystem::path& from, const std::filesystem::path& to) -> void;
    // Entry names of a folder, one per line. Empty when the folder does not exist.
    auto fs_list_dir(const std::filesystem::path& path) -> std::string;
    // Size of a file, or -1 when it does not exist or is not a file.
    auto fs_file_size(const std::filesystem::path& path) -> int64_t;
    auto fs_is_dir(const std::filesystem::path& path) -> bool;
    // "<total bytes> <file count>" for a folder tree or a single file.
    auto fs_tree_stats(const std::filesystem::path& path) -> std::string;

    // --- Assets.cpp
    // Loads assets from the asset registry and keeps each one alive until
    // free_all_assets. `mode` is "data" (everything except bulk content such as textures,
    // meshes and sounds) or "all". Loading stops when less than `min_free_mb` megabytes of
    // physical memory are available. Returns the number of assets loaded.
    auto load_all_assets(const std::string& mode, uint64_t min_free_mb) -> size_t;
    auto free_all_assets() -> size_t;
    // How many assets this mod currently holds pinned.
    auto held_asset_count() -> size_t;
    auto dump_asset_registry(const std::filesystem::path& file) -> void;
    // Package paths of every map the asset registry lists, one per line.
    auto list_maps() -> std::string;
    // Package paths of the maps that are in memory now, one per line.
    auto list_loaded_maps() -> std::string;
    // Loads the map package as data, without travelling to it, and writes actors.json and
    // actor_values.jsonl for the actors saved in it into `dir`. No game code runs for the
    // map: no game mode, no BeginPlay. The map is released again before this returns.
    // Refuses when less than `min_free_mb` megabytes of memory are available.
    // Returns the number of actors written.
    auto dump_level(const std::string& package, const std::filesystem::path& dir, uint64_t min_free_mb) -> size_t;

    // --- TMapOverrides.cpp
    auto generate_tmap_overrides(const std::filesystem::path& dir) -> void;

    // --- Reflection.cpp
    auto dump_reflection(const std::filesystem::path& dir) -> void;
    auto dump_hooks(const std::filesystem::path& dir) -> void;

    // --- Names.cpp
    auto dump_names(const std::filesystem::path& file) -> void;

    // --- Scripts.cpp
    auto dump_scripts(const std::filesystem::path& file) -> void;

    // --- Actors.cpp
    auto dump_actors(const std::filesystem::path& file) -> void;
    // The same file for the actors of one world only: those whose outer chain ends in it.
    auto dump_actors_of(const std::filesystem::path& file, RC::Unreal::UObject* only_world) -> void;
    // Path of the world the first player controller is in, or "none".
    auto current_map_name() -> std::string;

    // The actors of the world the local player is in, with the components each owns.
    // An actor belongs to that world when its level is owned by it, which also covers
    // levels streamed in from other maps.
    struct WorldActors
    {
        RC::Unreal::UObject* world{};
        std::string world_path{};
        std::vector<RC::Unreal::UObject*> actors{};
        std::unordered_map<RC::Unreal::UObject*, std::vector<RC::Unreal::UObject*>> components{};
    };
    auto collect_player_world_actors() -> WorldActors;
    // The actors saved in `world`, a map loaded as data: those whose outer chain ends in it.
    auto collect_world_actors(RC::Unreal::UObject* world) -> WorldActors;

    // Ends the game process at once, without running exit handlers.
    auto end_process() -> void;

    // World/runtime.json: the game mode, game state, controller, pawn and HUD in use.
    auto dump_runtime_context(const std::filesystem::path& file) -> void;

    // --- Values.cpp
    // One JSON file per loaded data table, plus _index.json.
    auto dump_data_tables(const std::filesystem::path& dir) -> void;
    // data_assets.jsonl and curves.jsonl.
    auto dump_data_assets(const std::filesystem::path& dir) -> void;
    // Every loaded asset of a kind that has no dump of its own and is not bulk content,
    // with its property values, as one line each.
    auto dump_asset_values(const std::filesystem::path& file) -> void;
    // Default objects of every class configured through ini files.
    auto dump_config_objects(const std::filesystem::path& file) -> void;
    // The default object of every class and the component templates of each class.
    auto dump_class_defaults(const std::filesystem::path& file) -> void;
    // Every property of each actor and component in the world the local player is in.
    auto dump_world_values(const std::filesystem::path& file) -> void;
    // The same file for a given set of actors. Returns the number of actors written.
    auto dump_actor_values(const std::filesystem::path& file, WorldActors& world) -> size_t;
    auto dump_widget_trees(const std::filesystem::path& file) -> void;
    auto dump_gameplay_tags(const std::filesystem::path& file) -> void;

    // --- Fs.cpp
    // "<path>|<bytes>|<link time as unix seconds>" of the game executable.
    auto game_exe_info() -> std::string;

    // --- BPSDK.cpp
    auto generate_bp_sdk(const std::filesystem::path& dir, const std::string& backend) -> void;
} // namespace GmfDumper
