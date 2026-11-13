#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <unordered_map>

#include <DynamicOutput/DynamicOutput.hpp>
#include <Unreal/AActor.hpp>
#include <Unreal/Rotator.hpp>
#include <Unreal/UActorComponent.hpp>
#include <Unreal/UObjectGlobals.hpp>
#include <Unreal/UnrealCoreStructs.hpp>

namespace GmfDumper
{
    namespace
    {
        // Property names used below, looked up without adding them to the engine's name
        // table. A name the game never registered stays "none" and is simply not read.
        struct PropertyNames
        {
            FName root_component{STR("RootComponent"), FNAME_Find};
            FName relative_location{STR("RelativeLocation"), FNAME_Find};
            FName relative_rotation{STR("RelativeRotation"), FNAME_Find};
            FName relative_scale{STR("RelativeScale3D"), FNAME_Find};
            FName attach_parent{STR("AttachParent"), FNAME_Find};
            FName player{STR("Player"), FNAME_Find};
            FName owning_world{STR("OwningWorld"), FNAME_Find};
            FName static_mesh{STR("StaticMesh"), FNAME_Find};
            FName skeletal_mesh{STR("SkeletalMesh"), FNAME_Find};
            FName skinned_asset{STR("SkinnedAsset"), FNAME_Find};
        };

        auto is_none(FName name) -> bool
        {
            return name.GetComparisonIndex().ToUnstableInt() == 0;
        }

        template <typename T>
        auto property_value(UObject* object, FName name) -> T*
        {
            if (is_none(name))
            {
                return nullptr;
            }
            try
            {
                return object->GetValuePtrByPropertyNameInChain<T>(name);
            }
            catch (...)
            {
                return nullptr;
            }
        }

        // Reads an object pointer out of a property and returns it only when it points at
        // an object the engine still holds.
        auto object_property(MemoryChecker& memory, UObject* object, FName name) -> UObject*
        {
            auto** value = property_value<UObject*>(object, name);
            UObject* target = value ? *value : nullptr;
            return is_live_object(memory, target) ? target : nullptr;
        }

        // The level and world an object lives in, found by walking its outers.
        struct Placement
        {
            UObject* level{};
            UObject* world{};
        };

        auto placement_of(UObject* object, FName level_name, FName world_name) -> Placement
        {
            Placement placement{};
            for (UObject* outer = object->GetOuterPrivate(); outer; outer = outer->GetOuterPrivate())
            {
                UClass* outer_class = outer->GetClassPrivate();
                if (!outer_class)
                {
                    break;
                }
                FName class_name = outer_class->GetNamePrivate();
                if (!placement.level && class_name == level_name)
                {
                    placement.level = outer;
                }
                else if (class_name == world_name)
                {
                    placement.world = outer;
                    break;
                }
            }
            return placement;
        }

        // The world a level takes part in. A level streamed in from another map keeps that
        // map's world object as its outer, but its OwningWorld is the world being played.
        class LevelWorlds
        {
          public:
            auto world_of(MemoryChecker& memory, const PropertyNames& names, const Placement& placement) -> UObject*
            {
                if (!placement.level)
                {
                    return placement.world;
                }
                if (auto it = m_cache.find(placement.level); it != m_cache.end())
                {
                    return it->second;
                }
                UObject* owning = object_property(memory, placement.level, names.owning_world);
                UObject* result = owning ? owning : placement.world;
                m_cache.emplace(placement.level, result);
                return result;
            }

          private:
            std::unordered_map<UObject*, UObject*> m_cache{};
        };

        // The world the local player is in. A game keeps many worlds loaded; the one that
        // matters is the one a player controller with a player attached belongs to.
        auto find_player_world(MemoryChecker& memory, const PropertyNames& names, UObject** controller_out = nullptr) -> UObject*
        {
            auto* controller_class = UObjectGlobals::StaticFindObject<UClass*>(nullptr, nullptr, STR("/Script/Engine.PlayerController"));
            if (!controller_class)
            {
                return nullptr;
            }
            FName level_name{STR("Level"), FNAME_Find};
            FName world_name{STR("World"), FNAME_Find};
            UObject* found{};
            UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
                if (!object || *reinterpret_cast<uint64_t*>(object) == 0 || !object->GetClassPrivate() || is_default_object(object))
                {
                    return LoopAction::Continue;
                }
                if (!object->IsA(controller_class) || !object_property(memory, object, names.player))
                {
                    return LoopAction::Continue;
                }
                found = placement_of(object, level_name, world_name).world;
                if (found && controller_out)
                {
                    *controller_out = object;
                }
                return found ? LoopAction::Break : LoopAction::Continue;
            });
            return found;
        }

        auto write_vector(JsonWriter& json, std::string_view key, FVector* vector) -> void
        {
            json.key(key);
            if (!vector)
            {
                json.null();
                return;
            }
            json.begin_array();
            json.value(vector->X());
            json.value(vector->Y());
            json.value(vector->Z());
            json.end_array();
        }
    } // namespace

    static auto collect_actors(UObject* world, bool by_owning_world) -> WorldActors;

    auto current_map_name() -> std::string
    {
        MemoryChecker memory{};
        PropertyNames names{};
        UObject* world = find_player_world(memory, names);
        if (!world)
        {
            return "none";
        }
        PathCache paths{};
        return paths.path_of(world);
    }

    auto collect_player_world_actors() -> WorldActors
    {
        MemoryChecker memory{};
        PropertyNames names{};
        return collect_actors(find_player_world(memory, names), true);
    }

    auto collect_world_actors(UObject* world) -> WorldActors
    {
        return collect_actors(world, false);
    }

    // `by_owning_world` matches actors through their level's OwningWorld, which is right
    // for a world being played. A map loaded as data has no owning world, so its actors
    // are matched through their outers.
    auto collect_actors(UObject* world, bool by_owning_world) -> WorldActors
    {
        WorldActors result{};
        UClass* actor_class = AActor::StaticClass();
        UClass* component_class = UActorComponent::StaticClass();
        if (!actor_class || !component_class)
        {
            throw std::runtime_error{"the Actor or ActorComponent class was not found"};
        }
        MemoryChecker memory{};
        PropertyNames names{};
        result.world = world;
        if (!result.world)
        {
            return result;
        }
        PathCache paths{};
        result.world_path = paths.path_of(result.world);

        FName level_name{STR("Level"), FNAME_Find};
        FName world_name{STR("World"), FNAME_Find};
        LevelWorlds level_worlds{};
        std::unordered_map<UObject*, bool> wanted{};
        std::vector<UObject*> all_components{};

        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || *reinterpret_cast<uint64_t*>(object) == 0 || !object->GetClassPrivate() || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            if (object->IsA(actor_class))
            {
                Placement placement = placement_of(object, level_name, world_name);
                if (placement.level && (by_owning_world ? level_worlds.world_of(memory, names, placement) : placement.world) == result.world)
                {
                    wanted.emplace(object, true);
                    result.actors.push_back(object);
                }
            }
            else if (object->IsA(component_class))
            {
                all_components.push_back(object);
            }
            return LoopAction::Continue;
        });
        for (UObject* component : all_components)
        {
            UObject* owner = component->GetOuterPrivate();
            if (wanted.contains(owner))
            {
                result.components[owner].push_back(component);
            }
        }
        return result;
    }

    auto dump_runtime_context(const std::filesystem::path& file) -> void
    {
        // The objects a mod usually starts from: which game mode, game state, controller,
        // pawn and HUD the running game uses, each with its class and the parents of that class.
        MemoryChecker memory{};
        PropertyNames names{};
        UObject* controller{};
        UObject* world = find_player_world(memory, names, &controller);
        PathCache paths{};

        struct Entry
        {
            std::string role;
            std::string path;
            std::vector<std::string> classes;
        };
        std::vector<Entry> entries{};

        auto add = [&](const char* role, UObject* object) -> UObject* {
            if (!object || !is_live_object(memory, object))
            {
                return nullptr;
            }
            try
            {
                Entry entry{};
                entry.role = role;
                entry.path = paths.path_of(object);
                int guard{};
                for (UStruct* type = object->GetClassPrivate(); type && guard < 64; type = type->GetSuperStruct(), ++guard)
                {
                    entry.classes.push_back(paths.path_of(type));
                }
                entries.push_back(std::move(entry));
                return object;
            }
            catch (...)
            {
                return nullptr;
            }
        };
        auto child = [&](const char* role, UObject* owner, const TCHAR* property) -> UObject* {
            if (!owner)
            {
                return nullptr;
            }
            FName name{property, FNAME_Find};
            return add(role, object_property(memory, owner, name));
        };

        if (world)
        {
            add("world", world);
            child("game_mode", world, STR("AuthorityGameMode"));
            child("game_state", world, STR("GameState"));
            child("game_instance", world, STR("OwningGameInstance"));
            UObject* level = child("persistent_level", world, STR("PersistentLevel"));
            child("world_settings", level, STR("WorldSettings"));
        }
        if (controller)
        {
            add("player_controller", controller);
            child("local_player", controller, STR("Player"));
            UObject* pawn = child("pawn", controller, STR("Pawn"));
            child("player_state", controller, STR("PlayerState"));
            child("hud", controller, STR("MyHUD"));
            child("camera_manager", controller, STR("PlayerCameraManager"));
            child("movement_component", pawn, STR("CharacterMovement"));
            child("mesh_component", pawn, STR("Mesh"));
        }

        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        JsonWriter json{file};
        json.begin_object();
        json.field("schema", "gmfdumper.runtime/1");
        json.field("note", "classes lists the class of the object first, then each parent class up to Object");
        json.key("objects");
        json.begin_array(true);
        for (const auto& entry : entries)
        {
            json.begin_object();
            json.field("role", entry.role);
            json.field("path", entry.path);
            json.string_array("classes", entry.classes);
            json.end_object();
        }
        json.end_array();
        json.end_object();
        json.close();
    }

    auto dump_actors(const std::filesystem::path& file) -> void
    {
        dump_actors_of(file, nullptr);
    }

    auto dump_actors_of(const std::filesystem::path& file, UObject* only_world) -> void
    {
        UClass* actor_class = AActor::StaticClass();
        UClass* component_class = UActorComponent::StaticClass();
        if (!actor_class || !component_class)
        {
            throw std::runtime_error{"the Actor or ActorComponent class was not found"};
        }
        FName level_name{STR("Level"), FNAME_Find};
        FName world_name{STR("World"), FNAME_Find};

        struct ActorEntry
        {
            UObject* actor{};
            Placement placement{};
            std::vector<UObject*> components{};
        };
        std::vector<ActorEntry> actors{};
        std::unordered_map<UObject*, size_t> actor_index{};
        std::vector<UObject*> components{};
        MemoryChecker memory{};
        PropertyNames names{};
        LevelWorlds level_worlds{};

        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || *reinterpret_cast<uint64_t*>(object) == 0 || !object->GetClassPrivate() || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            if (object->IsA(actor_class))
            {
                Placement placement = placement_of(object, level_name, world_name);
                // Actors outside any level are templates inside Blueprint classes, not
                // things placed in a world.
                if (placement.level && (!only_world || placement.world == only_world))
                {
                    if (!only_world)
                    {
                        placement.world = level_worlds.world_of(memory, names, placement);
                    }
                    actor_index.emplace(object, actors.size());
                    actors.push_back({object, placement, {}});
                }
            }
            else if (object->IsA(component_class))
            {
                components.push_back(object);
            }
            return LoopAction::Continue;
        });

        for (UObject* component : components)
        {
            if (auto it = actor_index.find(component->GetOuterPrivate()); it != actor_index.end())
            {
                actors[it->second].components.push_back(component);
            }
        }

        UObject* player_world = find_player_world(memory, names);
        PathCache paths{};

        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        JsonWriter json{file};
        json.begin_object();
        json.field("schema", "gmfdumper.actors/1");
        json.field("transform_note", "location, rotation (pitch, yaw, roll) and scale are the root component's relative transform; "
                                     "for an actor that is not attached to another, that is its world transform");
        if (player_world)
        {
            json.field("player_world", paths.path_of(player_world));
        }
        else
        {
            json.null_field("player_world");
        }
        json.key("actors");
        json.begin_array(true);

        struct ComponentRow
        {
            std::string name;
            std::string class_path;
            std::string mesh;
        };

        size_t written{};
        size_t failed{};
        for (auto& entry : actors)
        {
            // Phase 1: read the game. Anything that throws here skips the actor before a
            // single byte of it is written.
            std::string path{}, class_path{}, level_path{}, world_path{}, root_name{}, attached_to{};
            UObject* root{};
            FVector* location{};
            FRotator* rotation{};
            FVector* scale{};
            double pitch{}, yaw{}, roll{};
            std::vector<ComponentRow> rows{};
            try
            {
                path = paths.path_of(entry.actor);
                class_path = paths.path_of(entry.actor->GetClassPrivate());
                level_path = paths.path_of(entry.placement.level);
                if (entry.placement.world)
                {
                    world_path = paths.path_of(entry.placement.world);
                }
                root = object_property(memory, entry.actor, names.root_component);
                if (root)
                {
                    root_name = name_to_utf8(root->GetNamePrivate());
                    location = property_value<FVector>(root, names.relative_location);
                    rotation = property_value<FRotator>(root, names.relative_rotation);
                    scale = property_value<FVector>(root, names.relative_scale);
                    if (rotation)
                    {
                        pitch = rotation->GetPitch();
                        yaw = rotation->GetYaw();
                        roll = rotation->GetRoll();
                    }
                    if (UObject* parent = object_property(memory, root, names.attach_parent))
                    {
                        attached_to = paths.path_of(parent);
                    }
                }
                for (UObject* component : entry.components)
                {
                    ComponentRow row{};
                    row.name = name_to_utf8(component->GetNamePrivate());
                    row.class_path = paths.path_of(component->GetClassPrivate());
                    for (FName mesh_property : {names.static_mesh, names.skeletal_mesh, names.skinned_asset})
                    {
                        if (UObject* mesh = object_property(memory, component, mesh_property))
                        {
                            row.mesh = paths.path_of(mesh);
                            break;
                        }
                    }
                    rows.push_back(std::move(row));
                }
            }
            catch (...)
            {
                ++failed;
                continue;
            }

            // Phase 2: write. Nothing below reads the game.
            json.begin_object();
            json.field("path", path);
            json.field("class", class_path);
            json.field("level", level_path);
            if (entry.placement.world)
            {
                json.field("world", world_path);
            }
            else
            {
                json.null_field("world");
            }
            json.field("in_player_world", player_world != nullptr && entry.placement.world == player_world);
            if (root)
            {
                json.field("root_component", root_name);
                write_vector(json, "location", location);
                json.key("rotation");
                if (rotation)
                {
                    json.begin_array();
                    json.value(pitch);
                    json.value(yaw);
                    json.value(roll);
                    json.end_array();
                }
                else
                {
                    json.null();
                }
                write_vector(json, "scale", scale);
                if (!attached_to.empty())
                {
                    json.field("attached_to", attached_to);
                }
            }
            else
            {
                json.null_field("root_component");
            }
            json.key("components");
            json.begin_array();
            for (const auto& row : rows)
            {
                json.begin_object();
                json.field("name", row.name);
                json.field("class", row.class_path);
                if (!row.mesh.empty())
                {
                    json.field("mesh", row.mesh);
                }
                json.end_object();
            }
            json.end_array();
            json.end_object();
            ++written;
        }

        json.end_array();
        json.field("count", static_cast<uint64_t>(written));
        json.end_object();
        json.close();
        Output::send(STR("[GmfDumper] actors: {} written, {} failed\n"), written, failed);
    }
} // namespace GmfDumper
