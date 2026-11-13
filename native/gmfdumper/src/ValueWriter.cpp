#include "ValueWriter.hpp"

#include <algorithm>
#include <cstring>

#include <Unreal/Core/Containers/FString.hpp>
#include <Unreal/CoreUObject/UObject/UnrealType.hpp>
#include <Unreal/FSoftObjectPath.hpp>
#include <Unreal/FText.hpp>
#include <Unreal/FWeakObjectPtr.hpp>
#include <Unreal/Property/FEnumProperty.hpp>
#include <Unreal/ScriptContainerLayout.hpp>
#include <Unreal/SoftObjectPtr.hpp>
#include <Unreal/UObjectGlobals.hpp>

namespace GmfDumper
{
    namespace
    {
        // Raw view of TArray and FString storage; the layout is the same on every
        // supported engine version.
        struct ScriptArrayView
        {
            void* Data;
            int32_t ArrayNum;
            int32_t ArrayMax;
        };

        // Upper bound on a container's element count before it is treated as garbage.
        constexpr int32_t MaxSaneContainerElements = 0x4000000;

        template <typename T>
        auto read_as(const void* ptr) -> T
        {
            T raw{};
            std::memcpy(&raw, ptr, sizeof(raw));
            return raw;
        }
    } // namespace

    auto seen_gameplay_tags() -> std::set<std::string>&
    {
        static std::set<std::string> tags{};
        return tags;
    }

    auto ValueWriter::enum_name(UEnum* uenum, int64_t number) -> const std::string*
    {
        auto it = m_enum_names.find(uenum);
        if (it == m_enum_names.end())
        {
            std::vector<std::pair<std::string, int64_t>> names{};
            for (auto& [key, entry_value] : uenum->ForEachName())
            {
                names.emplace_back(name_to_utf8(key), static_cast<int64_t>(entry_value));
            }
            it = m_enum_names.emplace(uenum, std::move(names)).first;
        }
        for (const auto& [name, entry_value] : it->second)
        {
            if (entry_value == number)
            {
                return &name;
            }
        }
        return nullptr;
    }

    auto ValueWriter::write_object(UObject* target, JsonWriter& json) -> void
    {
        if (!target)
        {
            json.null();
            return;
        }
        if (!is_live_object(m_memory, target))
        {
            skip(json);
            return;
        }
        std::string path{};
        try
        {
            path = m_paths.path_of(target);
        }
        catch (...)
        {
            skip(json);
            return;
        }
        json.value(path);
    }

    auto ValueWriter::struct_values(UStruct* type, void* container, JsonWriter& json, int depth) -> void
    {
        if (!type || !container || depth > m_limits.max_depth)
        {
            skip(json);
            return;
        }

        // The property list is read before anything is written. A shadowed name further up
        // the super chain would give a duplicate JSON key; only the first occurrence, which
        // is the most derived one, is kept.
        std::vector<std::pair<FProperty*, std::string>> properties{};
        try
        {
            std::set<std::string> names{};
            for (FProperty* property : TFieldRange<FProperty>(type, EFieldIterationFlags::IncludeSuper))
            {
                std::string name = name_to_utf8(property->GetFName());
                if (names.insert(name).second)
                {
                    properties.emplace_back(property, std::move(name));
                }
            }
        }
        catch (...)
        {
            skip(json);
            return;
        }

        if (!m_looked_for_tag_struct)
        {
            m_looked_for_tag_struct = true;
            m_gameplay_tag_struct = UObjectGlobals::StaticFindObject<UObject*>(nullptr, nullptr, STR("/Script/GameplayTags.GameplayTag"));
        }
        const bool is_gameplay_tag = m_gameplay_tag_struct != nullptr && type == m_gameplay_tag_struct;

        json.begin_object();
        for (auto& [property, name] : properties)
        {
            int32_t array_dim = 1;
            try
            {
                array_dim = property->GetArrayDim();
            }
            catch (...)
            {
                array_dim = 0;
            }
            json.key(name);
            if (array_dim == 1)
            {
                value(property, container, 0, json, depth + 1);
            }
            else if (array_dim > 1 && array_dim <= 4096)
            {
                json.begin_array();
                for (int32_t i = 0; i < array_dim; ++i)
                {
                    value(property, container, i, json, depth + 1);
                }
                json.end_array();
            }
            else
            {
                skip(json);
            }

            if (is_gameplay_tag && name == "TagName")
            {
                try
                {
                    void* ptr = static_cast<uint8_t*>(container) + property->GetOffset_Internal();
                    if (m_memory.is_readable(ptr, sizeof(FName)))
                    {
                        std::string tag = name_to_utf8(read_as<FName>(ptr));
                        if (!tag.empty() && tag != "None")
                        {
                            m_tags.insert(tag);
                            seen_gameplay_tags().insert(std::move(tag));
                        }
                    }
                }
                catch (...)
                {
                }
            }
        }
        json.end_object();
    }

    auto ValueWriter::value(FProperty* property, void* container, int32_t index, JsonWriter& json, int depth) -> void
    {
        // Each branch reads what it needs first and writes afterwards, so an exception from
        // a read never leaves a half-written value. The catch at the end covers reads that
        // throw before the branch wrote anything; branches that have started writing a
        // container only call functions that cannot throw past them.
        if (!property || !container || depth > m_limits.max_depth)
        {
            skip(json);
            return;
        }

        int32_t element_size{};
        void* ptr{};
        try
        {
            element_size = property->GetElementSize();
            ptr = static_cast<uint8_t*>(container) + property->GetOffset_Internal() + static_cast<int64_t>(index) * element_size;
        }
        catch (...)
        {
            skip(json);
            return;
        }
        if (element_size <= 0 || !m_memory.is_readable(ptr, static_cast<size_t>(element_size)))
        {
            skip(json);
            return;
        }

        try
        {
            auto property_class = property->GetClass();

            if (property_class.HasAnyCastFlags(CASTCLASS_FStructProperty))
            {
                UScriptStruct* value_struct = static_cast<FStructProperty*>(property)->GetStruct();
                // struct_values passes depth + 1 to each member, so the struct itself is
                // not counted a second time here.
                struct_values(value_struct, ptr, json, depth);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FBoolProperty))
            {
                auto* bool_property = static_cast<FBoolProperty*>(property);
                uint8_t byte = *(static_cast<uint8_t*>(ptr) + bool_property->GetByteOffset());
                bool flag = (byte & bool_property->GetByteMask()) != 0;
                json.value(flag);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FStrProperty))
            {
                auto* view = static_cast<const ScriptArrayView*>(ptr);
                if (!view->Data || view->ArrayNum <= 0)
                {
                    json.value("");
                    return;
                }
                if (view->ArrayNum > MaxSaneContainerElements || !m_memory.is_readable(view->Data, static_cast<size_t>(view->ArrayNum) * sizeof(TCHAR)))
                {
                    skip(json);
                    return;
                }
                std::string text = to_utf8_string(StringType{static_cast<const TCHAR*>(view->Data), static_cast<size_t>(view->ArrayNum - 1)});
                json.value(text);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FUtf8StrProperty) || property_class.HasAnyCastFlags(CASTCLASS_FAnsiStrProperty))
            {
                auto* view = static_cast<const ScriptArrayView*>(ptr);
                if (!view->Data || view->ArrayNum <= 0)
                {
                    json.value("");
                    return;
                }
                if (view->ArrayNum > MaxSaneContainerElements || !m_memory.is_readable(view->Data, static_cast<size_t>(view->ArrayNum)))
                {
                    skip(json);
                    return;
                }
                json.value(std::string_view{static_cast<const char*>(view->Data), static_cast<size_t>(view->ArrayNum - 1)});
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FNameProperty))
            {
                // The engine's FName size is a runtime value; copy the smallest of the three
                // sizes so the read stays inside the property and inside the local.
                auto copy_size = std::min({static_cast<size_t>(FName::StaticSize()), sizeof(FName), static_cast<size_t>(element_size)});
                FName name{};
                std::memcpy(&name, ptr, copy_size);
                json.value(name_to_utf8(name));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FTextProperty))
            {
                // An FText starts with a pointer to its text data, an object with a virtual
                // table. The engine follows that pointer without checking it, so it is
                // checked here first: a bad one would crash the game, not raise an error.
                auto* text_data = read_as<void*>(ptr);
                if (!text_data)
                {
                    json.value("");
                    return;
                }
                if ((reinterpret_cast<uintptr_t>(text_data) & 0x7) != 0 || !m_memory.is_readable(text_data, sizeof(void*)) ||
                    !m_memory.is_readable(read_as<void*>(text_data), sizeof(void*)))
                {
                    skip(json);
                    return;
                }
                std::string text = to_utf8_string(static_cast<const FText*>(ptr)->ToString());
                json.value(text);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FEnumProperty))
            {
                auto* enum_property = static_cast<FEnumProperty*>(property);
                FNumericProperty* underlying = enum_property->GetUnderlyingProp();
                UEnum* uenum = enum_property->GetEnum();
                if (!underlying)
                {
                    skip(json);
                    return;
                }
                void* value_ptr = static_cast<uint8_t*>(ptr) + underlying->GetOffset_Internal();
                auto underlying_class = underlying->GetClass();
                int64_t number{};
                if (underlying_class.HasAnyCastFlags(CASTCLASS_FByteProperty))
                {
                    number = read_as<uint8_t>(value_ptr);
                }
                else if (underlying_class.HasAnyCastFlags(CASTCLASS_FInt8Property))
                {
                    number = read_as<int8_t>(value_ptr);
                }
                else if (underlying_class.HasAnyCastFlags(CASTCLASS_FInt16Property))
                {
                    number = read_as<int16_t>(value_ptr);
                }
                else if (underlying_class.HasAnyCastFlags(CASTCLASS_FIntProperty))
                {
                    number = read_as<int32_t>(value_ptr);
                }
                else if (underlying_class.HasAnyCastFlags(CASTCLASS_FInt64Property))
                {
                    number = read_as<int64_t>(value_ptr);
                }
                else if (underlying_class.HasAnyCastFlags(CASTCLASS_FUInt16Property))
                {
                    number = read_as<uint16_t>(value_ptr);
                }
                else if (underlying_class.HasAnyCastFlags(CASTCLASS_FUInt32Property))
                {
                    number = read_as<uint32_t>(value_ptr);
                }
                else if (underlying_class.HasAnyCastFlags(CASTCLASS_FUInt64Property))
                {
                    number = static_cast<int64_t>(read_as<uint64_t>(value_ptr));
                }
                else
                {
                    skip(json);
                    return;
                }
                const std::string* name = uenum ? enum_name(uenum, number) : nullptr;
                name ? json.value(*name) : json.value(number);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FByteProperty))
            {
                auto number = static_cast<int64_t>(read_as<uint8_t>(ptr));
                UEnum* uenum = static_cast<FByteProperty*>(property)->GetEnum();
                const std::string* name = uenum ? enum_name(uenum, number) : nullptr;
                name ? json.value(*name) : json.value(number);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FFloatProperty))
            {
                json.value(read_as<float>(ptr));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FDoubleProperty))
            {
                json.value(read_as<double>(ptr));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FInt8Property))
            {
                json.value(static_cast<int64_t>(read_as<int8_t>(ptr)));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FInt16Property))
            {
                json.value(static_cast<int64_t>(read_as<int16_t>(ptr)));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FIntProperty))
            {
                json.value(static_cast<int64_t>(read_as<int32_t>(ptr)));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FInt64Property))
            {
                json.value(read_as<int64_t>(ptr));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FUInt16Property))
            {
                json.value(static_cast<uint64_t>(read_as<uint16_t>(ptr)));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FUInt32Property))
            {
                json.value(static_cast<uint64_t>(read_as<uint32_t>(ptr)));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FUInt64Property))
            {
                json.value(read_as<uint64_t>(ptr));
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FObjectProperty))
            {
                // Covers class properties too; a class is an object.
                write_object(read_as<UObject*>(ptr), json);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FWeakObjectProperty))
            {
                // Get() validates the index and serial number against the object array.
                UObject* target = static_cast<const FWeakObjectPtr*>(ptr)->Get();
                write_object(target, json);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FInterfaceProperty))
            {
                // FScriptInterface starts with the object pointer.
                write_object(read_as<UObject*>(ptr), json);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FSoftObjectProperty))
            {
                // The asset part of the path only: UEPseudo resolves its layout per engine
                // version. The sub-object part changed type in UE 5.6 and is left out.
                auto* soft = static_cast<const FSoftObjectPtr*>(ptr);
                FString asset = soft->GetUniqueID().GetAssetPathString();
                std::string text = asset.Len() > 0 ? to_utf8_string(StringType{*asset}) : std::string{};
                if (text == "None")
                {
                    text.clear();
                }
                json.value(text);
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FArrayProperty))
            {
                FProperty* inner = static_cast<FArrayProperty*>(property)->GetInner();
                auto* view = static_cast<const ScriptArrayView*>(ptr);
                if (!inner || view->ArrayNum < 0 || view->ArrayNum > MaxSaneContainerElements)
                {
                    skip(json);
                    return;
                }
                int32_t inner_size = inner->GetElementSize();
                if (view->ArrayNum > 0 && (!view->Data || inner_size <= 0 ||
                                           !m_memory.is_readable(view->Data, static_cast<size_t>(view->ArrayNum) * static_cast<size_t>(inner_size))))
                {
                    skip(json);
                    return;
                }
                // Raw byte buffers say nothing as a list of numbers; give their size.
                auto inner_class = inner->GetClass();
                bool is_bytes = inner_class.HasAnyCastFlags(CASTCLASS_FByteProperty) && static_cast<FByteProperty*>(inner)->GetEnum() == nullptr;
                if (is_bytes && view->ArrayNum > 256)
                {
                    json.begin_object();
                    json.field("_bytes", static_cast<int64_t>(view->ArrayNum));
                    json.end_object();
                    return;
                }
                int32_t count = std::min(view->ArrayNum, m_limits.max_elements);
                bool cut = count < view->ArrayNum;
                if (cut)
                {
                    ++truncated;
                    json.begin_object();
                    json.field("_count", static_cast<int64_t>(view->ArrayNum));
                    json.key("_first");
                }
                json.begin_array();
                for (int32_t i = 0; i < count; ++i)
                {
                    value(inner, view->Data, i, json, depth + 1);
                }
                json.end_array();
                if (cut)
                {
                    json.end_object();
                }
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FMapProperty))
            {
                auto* map_property = static_cast<FMapProperty*>(property);
                FProperty* key_prop = map_property->GetKeyProp();
                FProperty* value_prop = map_property->GetValueProp();
                if (!key_prop || !value_prop)
                {
                    skip(json);
                    return;
                }
                auto* map = static_cast<FScriptMap*>(ptr);
                auto layout = ScriptContainerLayout::ComputeMapLayout(key_prop, value_prop);
                auto stride = static_cast<size_t>(layout.SetLayout.Size);
                int32_t max_index = map->GetMaxIndex();
                if (max_index < 0 || max_index > MaxSaneContainerElements)
                {
                    skip(json);
                    return;
                }
                // Collect the readable slots first; nothing is written until the scan is done.
                std::vector<void*> slots{};
                int64_t total{};
                for (int32_t i = 0; i < max_index; ++i)
                {
                    if (!map->IsValidIndex(i))
                    {
                        continue;
                    }
                    ++total;
                    if (static_cast<int32_t>(slots.size()) >= m_limits.max_elements)
                    {
                        continue;
                    }
                    void* pair_ptr = map->GetData(i, layout);
                    if (m_memory.is_readable(pair_ptr, stride))
                    {
                        slots.push_back(pair_ptr);
                    }
                }
                const bool cut = total > m_limits.max_elements;
                if (cut)
                {
                    ++truncated;
                    json.begin_object();
                    json.field("_count", total);
                    json.key("_first");
                }
                json.begin_array();
                for (void* pair_ptr : slots)
                {
                    json.begin_object();
                    json.key("key");
                    value(key_prop, pair_ptr, 0, json, depth + 1);
                    json.key("value");
                    value(value_prop, pair_ptr, 0, json, depth + 1);
                    json.end_object();
                }
                json.end_array();
                if (cut)
                {
                    json.end_object();
                }
                return;
            }
            if (property_class.HasAnyCastFlags(CASTCLASS_FSetProperty))
            {
                FProperty* element_prop = static_cast<FSetProperty*>(property)->GetElementProp();
                if (!element_prop)
                {
                    skip(json);
                    return;
                }
                auto* set = static_cast<FScriptSet*>(ptr);
                auto layout = ScriptContainerLayout::ComputeSetLayout(element_prop);
                auto stride = static_cast<size_t>(layout.Size);
                int32_t max_index = set->GetMaxIndex();
                if (max_index < 0 || max_index > MaxSaneContainerElements)
                {
                    skip(json);
                    return;
                }
                std::vector<void*> slots{};
                int64_t total{};
                for (int32_t i = 0; i < max_index; ++i)
                {
                    if (!set->IsValidIndex(i))
                    {
                        continue;
                    }
                    ++total;
                    if (static_cast<int32_t>(slots.size()) >= m_limits.max_elements)
                    {
                        continue;
                    }
                    void* element_ptr = set->GetData(i, layout);
                    if (m_memory.is_readable(element_ptr, stride))
                    {
                        slots.push_back(element_ptr);
                    }
                }
                const bool cut = total > m_limits.max_elements;
                if (cut)
                {
                    ++truncated;
                    json.begin_object();
                    json.field("_count", total);
                    json.key("_first");
                }
                json.begin_array();
                for (void* element_ptr : slots)
                {
                    value(element_prop, element_ptr, 0, json, depth + 1);
                }
                json.end_array();
                if (cut)
                {
                    json.end_object();
                }
                return;
            }

            // Delegates, lazy pointers, field paths and optionals are not read. They are
            // counted apart from values that could not be read safely.
            ++not_supported;
            json.null();
        }
        catch (...)
        {
            skip(json);
        }
    }
} // namespace GmfDumper
