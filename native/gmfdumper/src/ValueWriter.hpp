#pragma once

// Turns property values of live objects into JSON.
//
// The reading rules follow UE4SS's .jmap generator (JMapGenerator.cpp): every pointer is
// checked for readability before it is followed, object pointers are checked against the
// engine's object array, and container sizes are bounded. On top of that this writer also
// reads text, soft object paths, weak pointers and interface pointers, which the .jmap
// leaves out and which hold much of what a modder looks for (display names, asset links).

#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "GmfCommon.hpp"

namespace RC::Unreal
{
    class FProperty;
    class UEnum;
} // namespace RC::Unreal

namespace GmfDumper
{
    class ValueWriter
    {
      public:
        struct Limits
        {
            // Arrays, sets and maps longer than this are cut; the output says so.
            int32_t max_elements{10000};
            // Nesting of structs and containers beyond this is written as null. A transform
            // inside a struct inside an array of structs on a component is already six deep.
            int32_t max_depth{16};
        };

        ValueWriter(PathCache& paths, MemoryChecker& memory, Limits limits) : m_paths(paths), m_memory(memory), m_limits(limits)
        {
        }

        // Writes { "PropertyName": value, ... } for every property of `type`, read from
        // `container`. Always writes exactly one JSON value.
        auto struct_values(UStruct* type, void* container, JsonWriter& json, int depth = 0) -> void;

        // Writes the value of one property. Always writes exactly one JSON value; a value
        // that cannot be read safely is written as null and counted.
        auto value(FProperty* property, void* container, int32_t index, JsonWriter& json, int depth) -> void;

        // Gameplay tag names seen in the values written so far.
        auto tags() const -> const std::set<std::string>&
        {
            return m_tags;
        }

        // Values written as null because reading them was not safe.
        size_t unreadable{};
        // Values written as null because their kind is not read at all.
        size_t not_supported{};
        // Containers written in their cut form.
        size_t truncated{};

      private:
        auto enum_name(UEnum* uenum, int64_t number) -> const std::string*;
        auto write_object(UObject* target, JsonWriter& json) -> void;
        auto skip(JsonWriter& json) -> void
        {
            ++unreadable;
            json.null();
        }

        PathCache& m_paths;
        MemoryChecker& m_memory;
        Limits m_limits;
        std::unordered_map<UEnum*, std::vector<std::pair<std::string, int64_t>>> m_enum_names{};
        std::set<std::string> m_tags{};
        UObject* m_gameplay_tag_struct{};
        bool m_looked_for_tag_struct{};
    };

    // Gameplay tag names collected by every value dump of this game session.
    auto seen_gameplay_tags() -> std::set<std::string>&;
} // namespace GmfDumper
