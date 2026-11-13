#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <map>
#include <optional>
#include <unordered_set>

#include <Unreal/CoreUObject/UObject/UnrealType.hpp>
#include <Unreal/UObjectGlobals.hpp>

namespace GmfDumper
{
    // Writes the TMap override files FModel and UAssetAPI need to read maps whose key or
    // value is a natively serialized struct. The selection rule is the one in UE4SS's own
    // generator (UE4SS/src/SDKGenerator/TMapOverrideGen.cpp), which is reachable only from
    // a button in the UE4SS window: native classes and structs, map properties, the first
    // property seen per name, and a struct key or value flagged STRUCT_SerializeNative.
    auto generate_tmap_overrides(const std::filesystem::path& dir) -> void
    {
        struct Override
        {
            std::optional<std::string> key;
            std::optional<std::string> value;
        };
        std::map<std::string, Override> overrides{};
        std::unordered_set<FName> seen{};

        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || !object->GetClassPrivate())
            {
                return LoopAction::Continue;
            }
            auto* as_struct = Cast<UStruct>(object);
            if (!as_struct)
            {
                return LoopAction::Continue;
            }
            auto* as_class = Cast<UClass>(object);
            auto* as_script_struct = as_class ? static_cast<UScriptStruct*>(nullptr) : Cast<UScriptStruct>(object);
            if (!as_class && !as_script_struct)
            {
                return LoopAction::Continue;
            }
            bool is_native = (as_class && as_class->HasAnyClassFlags(CLASS_Native)) ||
                             (as_script_struct && as_script_struct->HasAnyStructFlags(STRUCT_Native));
            if (!is_native)
            {
                return LoopAction::Continue;
            }

            for (FProperty* property : TFieldRange<FProperty>(as_struct, EFieldIterationFlags::IncludeDeprecated))
            {
                if (!property->IsA<FMapProperty>() || seen.contains(property->GetFName()))
                {
                    continue;
                }
                seen.insert(property->GetFName());

                auto* map_property = static_cast<FMapProperty*>(property);
                auto serialized_struct_name = [](FProperty* inner) -> std::optional<std::string> {
                    auto* struct_property = CastField<FStructProperty>(inner);
                    UScriptStruct* type = struct_property ? struct_property->GetStruct() : nullptr;
                    if (type && type->HasAnyStructFlags(STRUCT_SerializeNative))
                    {
                        return to_utf8_string(type->GetName());
                    }
                    return std::nullopt;
                };
                Override entry{serialized_struct_name(map_property->GetKeyProp()), serialized_struct_name(map_property->GetValueProp())};
                if (entry.key || entry.value)
                {
                    overrides.emplace(name_to_utf8(property->GetFName()), std::move(entry));
                }
            }
            return LoopAction::Continue;
        });

        fs_make_dirs(dir);

        // FModel: { "Property": { "Key": "Struct" | "", "Value": "Struct" | "" } }
        {
            JsonWriter json{dir / "FModelTMapOverrides.json"};
            json.begin_object();
            for (const auto& [name, entry] : overrides)
            {
                json.key(name);
                json.begin_object();
                json.field("Key", entry.key.value_or(""));
                json.field("Value", entry.value.value_or(""));
                json.end_object();
            }
            json.end_object();
            json.close();
        }

        // UAssetAPI: { "Property": [ "Struct" | null, "Struct" | null ] }
        {
            JsonWriter json{dir / "UAssetAPITMapOverrides.json"};
            json.begin_object();
            for (const auto& [name, entry] : overrides)
            {
                json.key(name);
                json.begin_array();
                entry.key ? json.value(*entry.key) : json.null();
                entry.value ? json.value(*entry.value) : json.null();
                json.end_array();
            }
            json.end_object();
            json.close();
        }
    }
} // namespace GmfDumper
