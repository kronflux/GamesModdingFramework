#include "GmfCommon.hpp"
#include "Dumpers.hpp"
#include "ValueWriter.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <unordered_map>
#include <unordered_set>

#include <DynamicOutput/DynamicOutput.hpp>
#include <Unreal/AActor.hpp>
#include <Unreal/CoreUObject/UObject/UnrealType.hpp>
#include <Unreal/Engine/UDataTable.hpp>
#include <Unreal/UActorComponent.hpp>
#include <Unreal/UObjectGlobals.hpp>

// Dumps of data, as opposed to types: table rows, data assets, configured defaults, the
// live actors of the current level, and the UI hierarchy. These are the values a modder
// changes; Reflection.cpp describes the shapes they have.

namespace GmfDumper
{
    namespace
    {
        auto find_class(const TCHAR* path) -> UClass*
        {
            return UObjectGlobals::StaticFindObject<UClass*>(nullptr, nullptr, path);
        }

        auto usable(UObject* object) -> bool
        {
            return object && *reinterpret_cast<uint64_t*>(object) != 0 && object->GetClassPrivate() != nullptr;
        }

        // A file name made from an object name; characters Windows refuses become "_".
        auto file_stem(std::string name) -> std::string
        {
            for (char& c : name)
            {
                auto u = static_cast<unsigned char>(c);
                if (u < 0x20 || std::strchr("<>:\"/\\|?*", c) != nullptr)
                {
                    c = '_';
                }
            }
            if (name.empty())
            {
                name = "unnamed";
            }
            return name.size() > 120 ? name.substr(0, 120) : name;
        }

        // Objects of one or more classes, collected in a single pass over the object array.
        auto collect(const std::vector<UClass*>& classes, bool want_default_objects) -> std::vector<UObject*>
        {
            std::vector<UObject*> found{};
            UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
                if (!usable(object) || is_default_object(object) != want_default_objects)
                {
                    return LoopAction::Continue;
                }
                for (UClass* each : classes)
                {
                    if (each && object->IsA(each))
                    {
                        found.push_back(object);
                        break;
                    }
                }
                return LoopAction::Continue;
            });
            return found;
        }

        // Writes one line of a .jsonl file: { path, class, values }.
        auto write_object_line(JsonWriter& json, ValueWriter& values, PathCache& paths, UObject* object, UObject* owner_class = nullptr) -> bool
        {
            std::string owner_path{};
            std::string path{}, class_path{};
            UClass* object_class{};
            try
            {
                object_class = object->GetClassPrivate();
                path = paths.path_of(object);
                class_path = paths.path_of(object_class);
                if (owner_class)
                {
                    owner_path = paths.path_of(owner_class);
                }
            }
            catch (...)
            {
                return false;
            }
            json.begin_object();
            json.field("path", path);
            json.field("class", class_path);
            if (owner_class)
            {
                json.field("owner_class", owner_path);
            }
            json.key("values");
            values.struct_values(object_class, object, json);
            json.end_object();
            json.line_break();
            return true;
        }

        auto dump_objects_as_lines(const std::filesystem::path& file, const std::vector<UObject*>& objects, const char* label) -> void
        {
            PathCache paths{};
            MemoryChecker memory{};
            ValueWriter values{paths, memory, {}};
            if (file.has_parent_path())
            {
                fs_make_dirs(file.parent_path());
            }
            JsonWriter json{file};
            // The first line describes the file, so it is never empty and a reader can tell
            // the format without knowing the tool.
            json.begin_object();
            json.field("schema", "gmfdumper.values/1");
            json.field("kind", label);
            json.field("candidates", static_cast<uint64_t>(objects.size()));
            json.field("format", "one JSON object per line after this one: path, class, values");
            json.end_object();
            json.line_break();

            size_t written{};
            for (UObject* object : objects)
            {
                written += write_object_line(json, values, paths, object) ? 1 : 0;
            }
            json.close();
            Output::send(STR("[GmfDumper] {}: {} objects, {} unreadable values, {} unsupported values, {} cut containers\n"),
                         to_wstring(std::string{label}),
                         written,
                         values.unreadable,
                         values.not_supported,
                         values.truncated);
        }
    } // namespace

    auto dump_data_tables(const std::filesystem::path& dir) -> void
    {
        UClass* table_class = UDataTable::StaticClass();
        if (!table_class)
        {
            throw std::runtime_error{"the DataTable class was not found"};
        }
        fs_make_dirs(dir);
        auto tables = collect({table_class}, false);

        PathCache paths{};
        MemoryChecker memory{};
        ValueWriter values{paths, memory, {}};

        struct IndexRow
        {
            std::string path;
            std::string row_struct;
            std::string file;
            int64_t rows{};
        };
        std::vector<IndexRow> index{};
        std::unordered_map<std::string, int> used_names{};
        size_t failed{};

        for (UObject* object : tables)
        {
            try
            {
                auto* table = static_cast<UDataTable*>(object);
                UScriptStruct* row_struct = table->GetRowStruct();
                if (!row_struct || !is_live_object(memory, row_struct))
                {
                    continue;
                }
                const auto& row_map = table->GetRowMap();

                // Read the row list before opening the file.
                std::vector<std::pair<std::string, unsigned char*>> rows{};
                for (const auto& pair : row_map)
                {
                    rows.emplace_back(name_to_utf8(pair.Key), pair.Value);
                }
                std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
                    return a.first < b.first;
                });

                IndexRow entry{};
                entry.path = paths.path_of(object);
                entry.row_struct = paths.path_of(row_struct);
                entry.rows = static_cast<int64_t>(rows.size());
                std::string stem = file_stem(name_to_utf8(object->GetNamePrivate()));
                // Windows file names ignore case, so two tables that differ only in case
                // must not get the same file.
                std::string key = stem;
                std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) {
                    return static_cast<char>(std::tolower(c));
                });
                int& uses = used_names[key];
                ++uses;
                entry.file = uses == 1 ? stem + ".json" : stem + "_" + std::to_string(uses) + ".json";

                auto row_size = static_cast<size_t>(row_struct->GetPropertiesSize());
                JsonWriter json{dir / to_path(entry.file)};
                json.begin_object();
                json.field("schema", "gmfdumper.datatable/1");
                json.field("path", entry.path);
                json.field("row_struct", entry.row_struct);
                json.field("row_count", entry.rows);
                json.key("rows");
                json.begin_array(true);
                for (auto& [row_name, row_data] : rows)
                {
                    json.begin_object();
                    json.field("name", row_name);
                    json.key("values");
                    if (row_data && row_size > 0 && memory.is_readable(row_data, row_size))
                    {
                        values.struct_values(row_struct, row_data, json);
                    }
                    else
                    {
                        json.null();
                    }
                    json.end_object();
                }
                json.end_array();
                json.end_object();
                json.close();
                index.push_back(std::move(entry));
            }
            catch (...)
            {
                ++failed;
            }
        }

        std::sort(index.begin(), index.end(), [](const IndexRow& a, const IndexRow& b) {
            return a.path < b.path;
        });
        JsonWriter json{dir / "_index.json"};
        json.begin_object();
        json.field("schema", "gmfdumper.datatables/1");
        json.field("count", static_cast<uint64_t>(index.size()));
        json.key("tables");
        json.begin_array(true);
        for (const auto& entry : index)
        {
            json.begin_object();
            json.field("path", entry.path);
            json.field("row_struct", entry.row_struct);
            json.field("rows", entry.rows);
            json.field("file", entry.file);
            json.end_object();
        }
        json.end_array();
        json.end_object();
        json.close();
        Output::send(STR("[GmfDumper] data tables: {} written, {} failed, {} unreadable values\n"), index.size(), failed, values.unreadable);
    }

    auto dump_data_assets(const std::filesystem::path& dir) -> void
    {
        fs_make_dirs(dir);
        if (UClass* asset_class = find_class(STR("/Script/Engine.DataAsset")))
        {
            dump_objects_as_lines(dir / "data_assets.jsonl", collect({asset_class}, false), "data assets");
        }
        else
        {
            throw std::runtime_error{"the DataAsset class was not found"};
        }
        if (UClass* curve_class = find_class(STR("/Script/Engine.CurveBase")))
        {
            dump_objects_as_lines(dir / "curves.jsonl", collect({curve_class}, false), "curves");
        }
    }

    auto dump_asset_values(const std::filesystem::path& file) -> void
    {
        // Assets of every other kind that carries settings as plain properties: sound
        // classes, input actions, physical materials, Niagara parameters and so on. Kinds
        // that have their own dump (tables, data assets, curves, classes) and kinds whose
        // content is bulk data (textures, meshes, sounds, animations, materials) are left out.
        static const TCHAR* const excluded_paths[] = {
                STR("/Script/CoreUObject.Field"),        STR("/Script/CoreUObject.Package"),    STR("/Script/Engine.Blueprint"),
                STR("/Script/Engine.World"),             STR("/Script/Engine.Level"),           STR("/Script/Engine.DataTable"),
                STR("/Script/Engine.DataAsset"),         STR("/Script/Engine.CurveBase"),       STR("/Script/Engine.Texture"),
                STR("/Script/Engine.StreamableRenderAsset"), STR("/Script/Engine.SoundBase"),   STR("/Script/Engine.AnimationAsset"),
                STR("/Script/Engine.Skeleton"),          STR("/Script/Engine.MaterialInterface"), STR("/Script/Engine.MaterialFunctionInterface"),
                STR("/Script/Engine.Font"),              STR("/Script/Engine.FontFace"),        STR("/Script/Engine.PhysicsAsset"),
                STR("/Script/Engine.Actor"),             STR("/Script/Engine.ActorComponent"),
        };
        std::vector<UClass*> excluded{};
        for (const TCHAR* path : excluded_paths)
        {
            if (UClass* found = find_class(path))
            {
                excluded.push_back(found);
            }
        }
        UClass* package_class = find_class(STR("/Script/CoreUObject.Package"));
        if (!package_class)
        {
            throw std::runtime_error{"the Package class was not found"};
        }

        PathCache names{};
        std::vector<UObject*> assets{};
        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!usable(object) || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            // An asset is an object that sits directly in a package.
            UObject* outer = object->GetOuterPrivate();
            if (!usable(outer) || outer->GetClassPrivate() != package_class)
            {
                return LoopAction::Continue;
            }
            for (UClass* each : excluded)
            {
                if (object->IsA(each))
                {
                    return LoopAction::Continue;
                }
            }
            try
            {
                // Native packages hold classes and their helpers; transient packages hold
                // objects made at run time. Neither is an asset.
                const std::string package = names.path_of(outer);
                if (package.rfind("/Script/", 0) == 0 || package.rfind("/Engine/Transient", 0) == 0 || package.rfind("/Temp/", 0) == 0 ||
                    package.rfind("/Memory/", 0) == 0)
                {
                    return LoopAction::Continue;
                }
            }
            catch (...)
            {
                return LoopAction::Continue;
            }
            assets.push_back(object);
            return LoopAction::Continue;
        });
        dump_objects_as_lines(file, assets, "asset values");
    }

    auto dump_config_objects(const std::filesystem::path& file) -> void
    {
        // The default object of every class that reads its values from the game's ini
        // files: project settings, input settings, game user settings and the like.
        std::vector<UObject*> objects{};
        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!usable(object))
            {
                return LoopAction::Continue;
            }
            UClass* object_class = object->GetClassPrivate();
            if ((object_class->GetClassCastFlags() & CASTCLASS_UClass) == 0 || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            try
            {
                auto* uclass = static_cast<UClass*>(object);
                auto flags = static_cast<uint32_t>(uclass->GetClassFlags());
                if ((flags & (CLASS_Config | CLASS_DefaultConfig)) == 0)
                {
                    return LoopAction::Continue;
                }
                // The config flag is inherited: every actor class carries it because Actor
                // does. Only a class that declares a config property itself has settings of
                // its own in an ini file.
                bool has_own_config_property{};
                for (FProperty* property : TFieldRange<FProperty>(uclass, EFieldIterationFlags::None))
                {
                    if ((static_cast<uint64_t>(property->GetPropertyFlags()) & CPF_Config) != 0)
                    {
                        has_own_config_property = true;
                        break;
                    }
                }
                if (!has_own_config_property)
                {
                    return LoopAction::Continue;
                }
                if (UObject* cdo = uclass->GetClassDefaultObject())
                {
                    objects.push_back(cdo);
                }
            }
            catch (...)
            {
            }
            return LoopAction::Continue;
        });
        dump_objects_as_lines(file, objects, "config objects");
    }

    auto dump_class_defaults(const std::filesystem::path& file) -> void
    {
        // What a class starts out with: its default object, and the component templates
        // that belong to it. A template is a component that hangs under a class or under a
        // default object instead of under an actor in a level: a Blueprint's components
        // (named <Variable>_GEN_VARIABLE) and the components a native class creates in its
        // constructor. A placed actor copies these, so they are what its own values are
        // compared with.
        UClass* component_class = UActorComponent::StaticClass();
        struct Row
        {
            UObject* object;
            UObject* owner_class;
        };
        std::vector<Row> defaults{};
        std::vector<Row> templates{};
        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!usable(object))
            {
                return LoopAction::Continue;
            }
            // is_default_object is also true for templates; here the two must be told apart.
            auto is_class_default = [](UObject* candidate) {
                return (static_cast<uint32_t>(candidate->GetObjectFlags()) & RF_ClassDefaultObject) != 0;
            };
            try
            {
                if (is_class_default(object))
                {
                    defaults.push_back({object, nullptr});
                    return LoopAction::Continue;
                }
                if (!component_class || !object->IsA(component_class))
                {
                    return LoopAction::Continue;
                }
                UObject* outer = object->GetOuterPrivate();
                for (int depth = 0; outer && depth < 8; ++depth)
                {
                    if (!usable(outer))
                    {
                        break;
                    }
                    if (is_class_default(outer))
                    {
                        templates.push_back({object, outer->GetClassPrivate()});
                        break;
                    }
                    if ((outer->GetClassPrivate()->GetClassCastFlags() & CASTCLASS_UClass) != 0)
                    {
                        templates.push_back({object, outer});
                        break;
                    }
                    outer = outer->GetOuterPrivate();
                }
            }
            catch (...)
            {
            }
            return LoopAction::Continue;
        });

        PathCache paths{};
        MemoryChecker memory{};
        // The same limits as the actor values, so the two compare value for value.
        ValueWriter values{paths, memory, {.max_elements = 500, .max_depth = 12}};
        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        JsonWriter json{file};
        json.begin_object();
        json.field("schema", "gmfdumper.class_defaults/1");
        json.field("defaults", static_cast<uint64_t>(defaults.size()));
        json.field("templates", static_cast<uint64_t>(templates.size()));
        json.field("format", "one JSON object per line after this one: path, class, values. A line with owner_class is a component "
                             "template of that class; a line without is the default object of its class.");
        json.end_object();
        json.line_break();
        size_t written{};
        for (auto& row : defaults)
        {
            written += write_object_line(json, values, paths, row.object) ? 1 : 0;
        }
        for (auto& row : templates)
        {
            written += write_object_line(json, values, paths, row.object, row.owner_class) ? 1 : 0;
        }
        json.close();
        Output::send(STR("[GmfDumper] class defaults: {} default objects, {} component templates, {} written, {} unreadable values\n"),
                     defaults.size(),
                     templates.size(),
                     written,
                     values.unreadable);
    }

    auto dump_gameplay_tags(const std::filesystem::path& file) -> void
    {
        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        auto out = open_text_file(file);
        out << "# Gameplay tags found in the values dumped during this game session.\n"
            << "# This is not the game's full tag list: a tag no dumped value uses is missing.\n";
        for (const auto& tag : seen_gameplay_tags())
        {
            out << tag << '\n';
        }
        out.flush();
        if (!out)
        {
            throw std::runtime_error{"write failed: " + path_to_utf8(file)};
        }
    }

    auto dump_widget_trees(const std::filesystem::path& file) -> void
    {
        UClass* widget_class = find_class(STR("/Script/UMG.Widget"));
        UClass* tree_class = find_class(STR("/Script/UMG.WidgetTree"));
        if (!widget_class || !tree_class)
        {
            throw std::runtime_error{"this game has no UMG widget classes loaded"};
        }
        FName slot_name{STR("Slot"), FNAME_Find};
        FName parent_name{STR("Parent"), FNAME_Find};
        FName root_name{STR("RootWidget"), FNAME_Find};
        MemoryChecker memory{};

        auto object_at = [&](UObject* object, FName name) -> UObject* {
            if (name.GetComparisonIndex().ToUnstableInt() == 0)
            {
                return nullptr;
            }
            try
            {
                auto** value = object->GetValuePtrByPropertyNameInChain<UObject*>(name);
                UObject* target = value ? *value : nullptr;
                return is_live_object(memory, target) ? target : nullptr;
            }
            catch (...)
            {
                return nullptr;
            }
        };

        std::vector<UObject*> trees{};
        std::unordered_map<UObject*, std::vector<UObject*>> widgets_of{};
        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!usable(object) || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            if (object->IsA(tree_class))
            {
                trees.push_back(object);
            }
            else if (object->IsA(widget_class))
            {
                widgets_of[object->GetOuterPrivate()].push_back(object);
            }
            return LoopAction::Continue;
        });

        PathCache paths{};
        struct Row
        {
            std::string name;
            std::string class_path;
            std::string parent;
            std::string slot_class;
        };
        struct Tree
        {
            std::string path;
            std::string owner;
            std::string owner_class;
            std::string root;
            bool is_template{};
            std::vector<Row> rows;
        };
        std::vector<Tree> output{};
        size_t failed{};

        for (UObject* tree : trees)
        {
            try
            {
                Tree entry{};
                entry.path = paths.path_of(tree);
                UObject* owner = tree->GetOuterPrivate();
                if (owner && is_live_object(memory, owner))
                {
                    entry.owner = paths.path_of(owner);
                    entry.owner_class = paths.path_of(owner->GetClassPrivate());
                    // A tree owned by a class is the designed layout; one owned by a widget
                    // object is a live copy of it.
                    entry.is_template = (owner->GetClassPrivate()->GetClassCastFlags() & CASTCLASS_UClass) != 0;
                }
                if (UObject* root = object_at(tree, root_name))
                {
                    entry.root = name_to_utf8(root->GetNamePrivate());
                }
                for (UObject* widget : widgets_of[tree])
                {
                    Row row{};
                    row.name = name_to_utf8(widget->GetNamePrivate());
                    row.class_path = paths.path_of(widget->GetClassPrivate());
                    if (UObject* slot = object_at(widget, slot_name))
                    {
                        row.slot_class = paths.path_of(slot->GetClassPrivate());
                        if (UObject* parent = object_at(slot, parent_name))
                        {
                            row.parent = name_to_utf8(parent->GetNamePrivate());
                        }
                    }
                    entry.rows.push_back(std::move(row));
                }
                std::sort(entry.rows.begin(), entry.rows.end(), [](const Row& a, const Row& b) {
                    return a.name < b.name;
                });
                output.push_back(std::move(entry));
            }
            catch (...)
            {
                ++failed;
            }
        }
        std::sort(output.begin(), output.end(), [](const Tree& a, const Tree& b) {
            return a.path < b.path;
        });

        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        JsonWriter json{file};
        json.begin_object();
        json.field("schema", "gmfdumper.widget_trees/1");
        json.field("note", "is_template true: the layout designed in the widget Blueprint. false: a live copy on screen or in memory.");
        json.field("count", static_cast<uint64_t>(output.size()));
        json.key("trees");
        json.begin_array(true);
        for (const auto& entry : output)
        {
            json.begin_object();
            json.field("path", entry.path);
            json.field("owner", entry.owner);
            json.field("owner_class", entry.owner_class);
            json.field("is_template", entry.is_template);
            json.field("root", entry.root);
            json.key("widgets");
            json.begin_array();
            for (const auto& row : entry.rows)
            {
                json.begin_object();
                json.field("name", row.name);
                json.field("class", row.class_path);
                json.field("parent", row.parent);
                json.field("slot_class", row.slot_class);
                json.end_object();
            }
            json.end_array();
            json.end_object();
        }
        json.end_array();
        json.end_object();
        json.close();
        Output::send(STR("[GmfDumper] widget trees: {} written, {} failed\n"), output.size(), failed);
    }

    auto dump_world_values(const std::filesystem::path& file) -> void
    {
        // Every property of each actor in the world the player is in, with its components.
        // Containers are cut shorter than elsewhere: a level can hold arrays of many
        // thousand instances.
        WorldActors world = collect_player_world_actors();
        if (!world.world)
        {
            throw std::runtime_error{"no local player world was found; load into the game first"};
        }
        dump_actor_values(file, world);
    }

    auto dump_actor_values(const std::filesystem::path& file, WorldActors& world) -> size_t
    {
        const std::string& world_path = world.world_path;
        auto& actors = world.actors;
        auto& components_of = world.components;

        PathCache paths{};
        MemoryChecker memory{};
        ValueWriter values{paths, memory, {.max_elements = 500, .max_depth = 12}};

        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        JsonWriter json{file};
        json.begin_object();
        json.field("schema", "gmfdumper.actor_values/1");
        json.field("world", world_path);
        json.field("count", static_cast<uint64_t>(actors.size()));
        json.field("format", "one JSON object per line after this one: path, class, values, components");
        json.end_object();
        json.line_break();

        size_t written{};
        for (UObject* actor : actors)
        {
            std::string path{}, class_path{};
            UClass* actor_type{};
            struct ComponentRow
            {
                UObject* object;
                UClass* type;
                std::string name;
                std::string class_path;
            };
            std::vector<ComponentRow> rows{};
            try
            {
                actor_type = actor->GetClassPrivate();
                path = paths.path_of(actor);
                class_path = paths.path_of(actor_type);
                for (UObject* component : components_of[actor])
                {
                    rows.push_back({component, component->GetClassPrivate(), name_to_utf8(component->GetNamePrivate()),
                                    paths.path_of(component->GetClassPrivate())});
                }
            }
            catch (...)
            {
                continue;
            }
            json.begin_object();
            json.field("path", path);
            json.field("class", class_path);
            json.key("values");
            values.struct_values(actor_type, actor, json);
            json.key("components");
            json.begin_array();
            for (auto& row : rows)
            {
                json.begin_object();
                json.field("name", row.name);
                json.field("class", row.class_path);
                json.key("values");
                values.struct_values(row.type, row.object, json);
                json.end_object();
            }
            json.end_array();
            json.end_object();
            json.line_break();
            ++written;
        }
        json.close();
        Output::send(STR("[GmfDumper] actor values: {} actors, {} unreadable values, {} unsupported values, {} cut containers\n"),
                     written,
                     values.unreadable,
                     values.not_supported,
                     values.truncated);
        return written;
    }
} // namespace GmfDumper
