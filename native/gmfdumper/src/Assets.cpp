#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <algorithm>
#include <unordered_map>
#include <unordered_set>

#include <DynamicOutput/DynamicOutput.hpp>
#include <UE4SSProgram.hpp>
#include <Unreal/FAssetData.hpp>
#include <Unreal/UAssetRegistry.hpp>
#include <Unreal/UAssetRegistryHelpers.hpp>
#include <Unreal/UObjectArray.hpp>
#include <Unreal/UObjectGlobals.hpp>
#include <Unreal/UnrealVersion.hpp>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>

namespace GmfDumper
{
    // Assets this mod loaded and pinned. UE4SS has its own list for the same purpose, but
    // its object dump, CXX header and Lua type generators release that list when they
    // finish, whether or not they filled it. A run here keeps assets loaded across many
    // dumpers, so it needs a list UE4SS does not clear.
    static std::vector<FUObjectItem*> s_pinned_assets{};

    // What the last load did with each asset, by asset path. Written into the asset list,
    // so a dump says for every asset whether it was loaded, left out on purpose, or could
    // not be loaded.
    static std::unordered_map<std::string, const char*> s_load_results{};

    static auto asset_path(FAssetData& asset) -> std::string
    {
        return name_to_utf8(asset.PackageName()) + "." + name_to_utf8(asset.AssetName());
    }

    // Physical memory Windows can still hand out, in megabytes.
    static auto available_memory_mb() -> uint64_t
    {
        MEMORYSTATUSEX state{};
        state.dwLength = sizeof(state);
        if (!GlobalMemoryStatusEx(&state))
        {
            return ~0ull;
        }
        return state.ullAvailPhys / (1024ull * 1024ull);
    }

    static auto asset_registry() -> UAssetRegistry*
    {
        // UE4SS also keeps a flag for this (bFAssetDataAvailable), but it is a plain inline
        // variable: a mod DLL gets its own copy that UE4SS never sets, so it cannot be read
        // here. The registry lookup below fails by itself when the game has none.
        if (Version::IsBelow(4, 17))
        {
            throw std::runtime_error{"the asset registry is not available before UE 4.17"};
        }
        auto* registry = static_cast<UAssetRegistry*>(UAssetRegistryHelpers::GetAssetRegistry().ObjectPointer);
        if (!registry)
        {
            throw std::runtime_error{"the asset registry was not found"};
        }
        return registry;
    }

    static auto asset_class_name(FAssetData& asset) -> std::string
    {
        if (Version::IsAtLeast(5, 1))
        {
            return name_to_utf8(asset.AssetClassPath().GetAssetName());
        }
        return name_to_utf8(asset.AssetClass());
    }

    // Asset kinds that are bulk content: pixels, geometry, samples, animation keys. They
    // hold no types and no tunable data, and they are most of the memory a game uses. In
    // "data" mode they are not loaded for their own sake. One that a Blueprint or data
    // asset refers to directly still loads with it; the engine does that by itself.
    static auto is_bulk_content(const std::string& class_name) -> bool
    {
        static const std::unordered_set<std::string> bulk{
                "Texture2D",
                "TextureCube",
                "Texture2DArray",
                "VolumeTexture",
                "TextureRenderTarget2D",
                "MediaTexture",
                "VirtualTexture2D",
                "StaticMesh",
                "SkeletalMesh",
                "Skeleton",
                "PhysicsAsset",
                "SoundWave",
                "MetaSoundSource",
                "MetaSoundPatch",
                "AnimSequence",
                "AnimMontage",
                "AnimComposite",
                "BlendSpace",
                "BlendSpace1D",
                "AimOffsetBlendSpace",
                "PoseAsset",
                "Material",
                "MaterialFunction",
                "MaterialInstanceConstant",
                "MaterialFunctionInstance",
                "NiagaraSystem",
                "NiagaraEmitter",
                "NiagaraScript",
                "ParticleSystem",
                "Font",
                "FontFace",
                "World",
                "MapBuildDataRegistry",
                "LevelSequence",
                "GroomAsset",
                "GeometryCollection",
                "LandscapeGrassType",
                "HLODLayer",
                "MediaSource",
                "FileMediaSource",
                "BinkMediaPlayer",
        };
        return bulk.contains(class_name);
    }

    auto load_all_assets(const std::string& mode, uint64_t min_free_mb) -> size_t
    {
        const bool everything = mode == "all";
        if (!everything && mode != "data")
        {
            throw std::runtime_error{"unknown asset loading mode '" + mode + "'; use \"data\" or \"all\""};
        }
        UAssetRegistry* registry = asset_registry();

        TArray<FAssetData> all_assets{nullptr, 0, 0};
        if (!registry->GetAllAssets(all_assets, false) || all_assets.Num() <= 0)
        {
            throw std::runtime_error{"the asset registry returned no assets"};
        }

        // The limit is the memory the machine has left, not the UE4SS setting
        // MaxMemoryUsageDuringAssetLoading. That setting is the share of memory in use by
        // every program on the machine; on a busy machine it is over the limit before the
        // game has loaded anything, and the load would be refused outright.
        const uint64_t available_at_start = available_memory_mb();
        if (available_at_start <= min_free_mb)
        {
            throw std::runtime_error{"not started: only " + std::to_string(available_at_start) + " MB of memory are available and " +
                                     std::to_string(min_free_mb) +
                                     " MB must stay free (load_assets.min_free_memory_gb in config.lua); close other programs or lower the setting"};
        }

        size_t considered{};
        size_t skipped_bulk{};
        size_t loaded{};
        size_t not_loadable{};
        size_t already_rooted{};
        bool out_of_memory{};
        s_load_results.clear();

        for (FAssetData& asset : all_assets)
        {
            ++considered;
            if (!everything && is_bulk_content(asset_class_name(asset)))
            {
                ++skipped_bulk;
                s_load_results[asset_path(asset)] = "skipped_bulk";
                continue;
            }
            if (available_memory_mb() <= min_free_mb)
            {
                out_of_memory = true;
                break;
            }

            UObject* object = UAssetRegistryHelpers::GetAsset(asset);
            if (!object)
            {
                ++not_loadable;
                s_load_results[asset_path(asset)] = "not_loadable";
                continue;
            }
            ++loaded;
            s_load_results[asset_path(asset)] = "loaded";
            FUObjectItem* item = object->GetObjectItem();
            // An object that is already rooted belongs to the game; pinning and later
            // unpinning it would remove a root the game set.
            if (item && !item->IsRootSet())
            {
                item->SetRootSet();
                item->SetGCKeep();
                s_pinned_assets.push_back(item);
            }
            else if (item)
            {
                ++already_rooted;
            }
        }

        Output::send(STR("[GmfDumper] assets: {} in the registry, {} loaded, {} bulk content skipped, {} not loadable, {} pinned, {} already kept by the "
                         "game, {} MB free before, {} MB free after\n"),
                     all_assets.Num(),
                     loaded,
                     skipped_bulk,
                     not_loadable,
                     s_pinned_assets.size(),
                     already_rooted,
                     available_at_start,
                     available_memory_mb());
        if (out_of_memory)
        {
            throw std::runtime_error{"stopped after " + std::to_string(considered) + " of " + std::to_string(all_assets.Num()) + " assets: only " +
                                     std::to_string(available_memory_mb()) + " MB of memory are left and " + std::to_string(min_free_mb) +
                                     " MB must stay free (load_assets.min_free_memory_gb in config.lua); " + std::to_string(loaded) +
                                     " assets were loaded and stay loaded until they are released"};
        }
        return loaded;
    }

    auto held_asset_count() -> size_t
    {
        return s_pinned_assets.size();
    }

    auto free_all_assets() -> size_t
    {
        size_t count = s_pinned_assets.size();
        for (FUObjectItem* item : s_pinned_assets)
        {
            item->UnsetRootSet();
            item->UnsetGCKeep();
        }
        s_pinned_assets.clear();
        Output::send(STR("[GmfDumper] released {} assets\n"), count);
        return count;
    }

    // The map worlds in memory, by package path: every World object that sits directly in
    // a package with a content path. Worlds the engine makes up at run time live under
    // /Engine/Transient, /Temp or /Memory and are left out.
    static auto loaded_map_worlds() -> std::unordered_map<std::string, UObject*>
    {
        std::unordered_map<std::string, UObject*> worlds{};
        auto* world_class = UObjectGlobals::StaticFindObject<UClass*>(nullptr, nullptr, STR("/Script/Engine.World"));
        if (!world_class)
        {
            return worlds;
        }
        PathCache paths{};
        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || *reinterpret_cast<uint64_t*>(object) == 0 || object->GetClassPrivate() != world_class)
            {
                return LoopAction::Continue;
            }
            UObject* package = object->GetOuterPrivate();
            if (!package || package->GetOuterPrivate() != nullptr)
            {
                return LoopAction::Continue;
            }
            try
            {
                std::string path = paths.path_of(package);
                // A map asset is named after its package: /Game/Maps/Lobby holds Lobby.
                std::string name = name_to_utf8(object->GetNamePrivate());
                const bool named_after_package = path.size() > name.size() && path.ends_with("/" + name);
                const bool made_up = path.starts_with("/Engine/Transient") || path.starts_with("/Temp/") || path.starts_with("/Memory/");
                if (named_after_package && !made_up)
                {
                    worlds.emplace(std::move(path), object);
                }
            }
            catch (...)
            {
            }
            return LoopAction::Continue;
        });
        return worlds;
    }

    auto list_maps() -> std::string
    {
        UAssetRegistry* registry = asset_registry();
        TArray<FAssetData> all_assets{nullptr, 0, 0};
        // Only what is on disk. Otherwise the registry describes a package that is in
        // memory by its loaded objects, and a map the game holds in a state that no longer
        // counts as an asset drops out of the list: Funnel Runners lost its Lobby map so.
        if (!registry->GetAllAssets(all_assets, true) || all_assets.Num() <= 0)
        {
            throw std::runtime_error{"the asset registry returned no assets"};
        }
        std::vector<std::string> maps{};
        for (FAssetData& asset : all_assets)
        {
            if (asset_class_name(asset) == "World")
            {
                maps.push_back(name_to_utf8(asset.PackageName()));
            }
        }
        // And the maps that are in memory now, whatever the registry says about them.
        for (auto& [package, world] : loaded_map_worlds())
        {
            maps.push_back(package);
        }
        std::sort(maps.begin(), maps.end());
        maps.erase(std::unique(maps.begin(), maps.end()), maps.end());
        std::string out{};
        for (const auto& map : maps)
        {
            out.append(map);
            out.push_back(char(10));
        }
        return out;
    }

    auto list_loaded_maps() -> std::string
    {
        std::vector<std::string> maps{};
        for (auto& [package, world] : loaded_map_worlds())
        {
            maps.push_back(package);
        }
        std::sort(maps.begin(), maps.end());
        std::string out{};
        for (const auto& map : maps)
        {
            out.append(map);
            out.push_back(char(10));
        }
        return out;
    }

    auto dump_level(const std::string& package, const std::filesystem::path& dir, uint64_t min_free_mb) -> size_t
    {
        const uint64_t available = available_memory_mb();
        if (available <= min_free_mb)
        {
            throw std::runtime_error{"not loaded: only " + std::to_string(available) + " MB of memory are available and " + std::to_string(min_free_mb) +
                                     " MB must stay free (load_assets.min_free_memory_gb in config.lua)"};
        }
        UAssetRegistry* registry = asset_registry();
        TArray<FAssetData> all_assets{nullptr, 0, 0};
        // Only what is on disk, as in list_maps.
        if (!registry->GetAllAssets(all_assets, true) || all_assets.Num() <= 0)
        {
            throw std::runtime_error{"the asset registry returned no assets"};
        }
        UObject* world{};
        bool found{};
        {
            auto loaded = loaded_map_worlds();
            if (auto it = loaded.find(package); it != loaded.end())
            {
                world = it->second;
                found = true;
            }
        }
        for (FAssetData& asset : all_assets)
        {
            if (found)
            {
                break;
            }
            if (asset_class_name(asset) == "World" && name_to_utf8(asset.PackageName()) == package)
            {
                found = true;
                world = UAssetRegistryHelpers::GetAsset(asset);
                break;
            }
        }
        if (!world)
        {
            // Not in the registry, or not loadable from it: use the map if it is in memory.
            auto loaded = loaded_map_worlds();
            if (auto it = loaded.find(package); it != loaded.end())
            {
                world = it->second;
                found = true;
            }
        }
        if (!found)
        {
            throw std::runtime_error{"the asset registry lists no map with this package path"};
        }
        if (!world)
        {
            throw std::runtime_error{"the map package could not be loaded"};
        }

        // Kept alive while it is read. A world the game itself keeps is left as it is.
        FUObjectItem* item = world->GetObjectItem();
        const bool pinned = item && !item->IsRootSet();
        if (pinned)
        {
            item->SetRootSet();
            item->SetGCKeep();
        }
        auto release = [&] {
            if (pinned)
            {
                item->UnsetRootSet();
                item->UnsetGCKeep();
            }
        };
        size_t written{};
        try
        {
            fs_make_dirs(dir);
            dump_actors_of(dir / "actors.json", world);
            WorldActors actors = collect_world_actors(world);
            written = dump_actor_values(dir / "actor_values.jsonl", actors);
        }
        catch (...)
        {
            release();
            throw;
        }
        release();
        return written;
    }

    auto dump_asset_registry(const std::filesystem::path& file) -> void
    {
        UAssetRegistry* registry = asset_registry();

        TArray<FAssetData> all_assets{nullptr, 0, 0};
        if (!registry->GetAllAssets(all_assets, false) || all_assets.Num() <= 0)
        {
            throw std::runtime_error{"the asset registry returned no assets"};
        }

        struct Row
        {
            std::string path;
            std::string package;
            std::string asset_class;
        };
        std::vector<Row> rows{};
        rows.reserve(static_cast<size_t>(all_assets.Num()));

        const bool has_class_path = Version::IsAtLeast(5, 1);
        for (FAssetData& asset : all_assets)
        {
            Row row{};
            row.package = name_to_utf8(asset.PackageName());
            row.path = row.package + "." + name_to_utf8(asset.AssetName());
            if (has_class_path)
            {
                auto& class_path = asset.AssetClassPath();
                row.asset_class = name_to_utf8(class_path.GetPackageName()) + "." + name_to_utf8(class_path.GetAssetName());
            }
            else
            {
                row.asset_class = name_to_utf8(asset.AssetClass());
            }
            rows.push_back(std::move(row));
        }
        std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) {
            return a.path < b.path;
        });

        // Which assets are in memory: the paths of all objects that sit directly in a
        // package, gathered in one pass. Looking each asset up by name instead took more
        // than half a minute on a game with fourteen thousand assets.
        std::unordered_set<std::string> in_memory{};
        {
            PathCache paths{};
            UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
                if (!object || *reinterpret_cast<uint64_t*>(object) == 0 || !object->GetClassPrivate())
                {
                    return LoopAction::Continue;
                }
                UObject* outer = object->GetOuterPrivate();
                if (!outer || outer->GetOuterPrivate() != nullptr)
                {
                    return LoopAction::Continue;
                }
                try
                {
                    in_memory.insert(paths.path_of(object));
                }
                catch (...)
                {
                }
                return LoopAction::Continue;
            });
        }

        size_t loaded_count{};
        for (const auto& row : rows)
        {
            loaded_count += in_memory.contains(row.path) ? 1 : 0;
        }

        JsonWriter json{file};
        json.begin_object();
        json.field("schema", "gmfdumper.assets/1");
        json.field("count", static_cast<uint64_t>(rows.size()));
        json.field("loaded_count", static_cast<uint64_t>(loaded_count));
        json.field("note", "loaded: the asset is in memory now. load_result, present after a full run: what the load step did with "
                           "the asset (loaded, skipped_bulk, not_loadable).");
        json.key("assets");
        json.begin_array(true);
        for (const auto& row : rows)
        {
            json.begin_object();
            json.field("path", row.path);
            json.field("package", row.package);
            json.field("class", row.asset_class);
            json.field("loaded", in_memory.contains(row.path));
            if (auto it = s_load_results.find(row.path); it != s_load_results.end())
            {
                json.field("load_result", it->second);
            }
            json.end_object();
        }
        json.end_array();
        json.end_object();
        json.close();
    }
} // namespace GmfDumper
