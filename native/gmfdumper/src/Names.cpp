#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <map>

#include <DynamicOutput/DynamicOutput.hpp>
#include <Unreal/CoreUObject/UObject/UnrealType.hpp>
#include <Unreal/Property/FEnumProperty.hpp>
#include <Unreal/Property/FOptionalProperty.hpp>
#include <Unreal/UObjectGlobals.hpp>

namespace GmfDumper
{
    namespace
    {
        // Every distinct name reachable through reflection, keyed by (index, number).
        class NameCollector
        {
          public:
            auto add(FName name) -> void
            {
                try
                {
                    auto key = std::make_pair(static_cast<uint32_t>(name.GetComparisonIndex().ToUnstableInt()), static_cast<uint32_t>(name.GetNumber()));
                    if (m_names.contains(key))
                    {
                        return;
                    }
                    m_names.emplace(key, name_to_utf8(name));
                }
                catch (...)
                {
                    ++failed;
                }
            }

            auto add_property(FProperty* property, int depth = 0) -> void
            {
                if (!property || depth > 8)
                {
                    return;
                }
                try
                {
                    add(property->GetFName());
                    add(property->GetClass().GetFName());
                    auto property_class = property->GetClass();
                    if (property_class.HasAnyCastFlags(CASTCLASS_FArrayProperty))
                    {
                        add_property(static_cast<FArrayProperty*>(property)->GetInner(), depth + 1);
                    }
                    else if (property_class.HasAnyCastFlags(CASTCLASS_FMapProperty))
                    {
                        add_property(static_cast<FMapProperty*>(property)->GetKeyProp(), depth + 1);
                        add_property(static_cast<FMapProperty*>(property)->GetValueProp(), depth + 1);
                    }
                    else if (property_class.HasAnyCastFlags(CASTCLASS_FSetProperty))
                    {
                        add_property(static_cast<FSetProperty*>(property)->GetElementProp(), depth + 1);
                    }
                    else if (property_class.HasAnyCastFlags(CASTCLASS_FEnumProperty))
                    {
                        add_property(static_cast<FEnumProperty*>(property)->GetUnderlyingProp(), depth + 1);
                    }
                    else if (property_class.HasAnyCastFlags(CASTCLASS_FOptionalProperty))
                    {
                        add_property(static_cast<FOptionalProperty*>(property)->GetValueProperty(), depth + 1);
                    }
                }
                catch (...)
                {
                    ++failed;
                }
            }

            auto names() const -> const std::map<std::pair<uint32_t, uint32_t>, std::string>&
            {
                return m_names;
            }

            size_t failed{};

          private:
            std::map<std::pair<uint32_t, uint32_t>, std::string> m_names{};
        };

        auto csv_field(const std::string& text) -> std::string
        {
            if (text.find_first_of(",\"\r\n") == std::string::npos)
            {
                return text;
            }
            std::string out{"\""};
            for (char c : text)
            {
                if (c == '"')
                {
                    out.push_back('"');
                }
                out.push_back(c);
            }
            out.push_back('"');
            return out;
        }
    } // namespace

    auto dump_names(const std::filesystem::path& file) -> void
    {
        NameCollector collector{};

        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || *reinterpret_cast<uint64_t*>(object) == 0)
            {
                return LoopAction::Continue;
            }
            UClass* object_class = object->GetClassPrivate();
            if (!object_class)
            {
                return LoopAction::Continue;
            }
            collector.add(object->GetNamePrivate());

            uint64_t cast_flags = object_class->GetClassCastFlags();
            if (is_default_object(object))
            {
                return LoopAction::Continue;
            }
            try
            {
                if ((cast_flags & CASTCLASS_UStruct) != 0)
                {
                    for (FProperty* property : TFieldRange<FProperty>(static_cast<UStruct*>(object), EFieldIterationFlags::IncludeDeprecated))
                    {
                        collector.add_property(property);
                    }
                }
                else if ((cast_flags & CASTCLASS_UEnum) != 0)
                {
                    for (auto& [entry_name, entry_value] : static_cast<UEnum*>(object)->ForEachName())
                    {
                        collector.add(entry_name);
                    }
                }
            }
            catch (...)
            {
                ++collector.failed;
            }
            return LoopAction::Continue;
        });

        if (file.has_parent_path())
        {
            fs_make_dirs(file.parent_path());
        }
        auto out = open_text_file(file);
        out << "index,number,name\n";
        for (const auto& [key, text] : collector.names())
        {
            out << key.first << ',' << key.second << ',' << csv_field(text) << '\n';
        }
        out.flush();
        if (!out)
        {
            throw std::runtime_error{"write failed: " + path_to_utf8(file)};
        }
        Output::send(STR("[GmfDumper] names: {} written, {} unreadable\n"), collector.names().size(), collector.failed);
    }
} // namespace GmfDumper
