#include "GmfCommon.hpp"
#include "Dumpers.hpp"
#include "FlagNames.hpp"

#include <DynamicOutput/DynamicOutput.hpp>
#include <Unreal/CoreUObject/UObject/UnrealType.hpp>
#include <Unreal/Property/FEnumProperty.hpp>
#include <Unreal/Property/FOptionalProperty.hpp>
#include <Unreal/UObjectGlobals.hpp>
#include <Unreal/UnrealVersion.hpp>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <Psapi.h>

namespace GmfDumper
{
    namespace
    {
        // The main executable's address range, so a native function address can be stored
        // as an offset that stays the same between game launches.
        struct MainModule
        {
            uint64_t base{};
            uint64_t end{};

            MainModule()
            {
                HMODULE module = GetModuleHandleW(nullptr);
                MODULEINFO info{};
                if (module && GetModuleInformation(GetCurrentProcess(), module, &info, sizeof(info)))
                {
                    base = reinterpret_cast<uint64_t>(info.lpBaseOfDll);
                    end = base + info.SizeOfImage;
                }
            }

            auto contains(uint64_t address) const -> bool
            {
                return address >= base && address < end;
            }
        };

        class ReflectionWriter
        {
          public:
            explicit ReflectionWriter(PathCache& paths) : m_paths(paths)
            {
            }

            auto object_path(UObject* object, JsonWriter& json, std::string_view key) -> void
            {
                if (object)
                {
                    json.field(key, m_paths.path_of(object));
                }
                else
                {
                    json.null_field(key);
                }
            }

            // Writes one property as a JSON object. Inner properties of containers are
            // written with the same shape, nested.
            auto property(FProperty* property, JsonWriter& json, bool as_parameter = false) -> void
            {
                json.begin_object();
                json.field("name", name_to_utf8(property->GetFName()));
                json.field("type", name_to_utf8(property->GetClass().GetFName()));
                json.field("offset", static_cast<int64_t>(property->GetOffset_Internal()));
                json.field("size", static_cast<int64_t>(property->GetElementSize()));
                json.field("array_dim", static_cast<int64_t>(property->GetArrayDim()));
                auto flags = static_cast<uint64_t>(property->GetPropertyFlags());
                json.field("flags", flags);
                json.string_array("flag_names", Flags::names(flags, Flags::s_property_flag_defs));
                if (as_parameter)
                {
                    bool is_return = (flags & CPF_ReturnParm) != 0;
                    json.field("return", is_return);
                    json.field("out", !is_return && (flags & CPF_OutParm) != 0);
                    json.field("const", (flags & CPF_ConstParm) != 0);
                    json.field("reference", (flags & CPF_ReferenceParm) != 0);
                }

                auto property_class = property->GetClass();
                if (property_class.HasAnyCastFlags(CASTCLASS_FStructProperty))
                {
                    object_path(static_cast<FStructProperty*>(property)->GetStruct(), json, "struct");
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FBoolProperty))
                {
                    auto* bool_property = static_cast<FBoolProperty*>(property);
                    json.field("field_size", static_cast<int64_t>(bool_property->GetFieldSize()));
                    json.field("byte_offset", static_cast<int64_t>(bool_property->GetByteOffset()));
                    json.field("byte_mask", static_cast<int64_t>(bool_property->GetByteMask()));
                    json.field("field_mask", static_cast<int64_t>(bool_property->GetFieldMask()));
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FArrayProperty))
                {
                    nested("inner", static_cast<FArrayProperty*>(property)->GetInner(), json);
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FEnumProperty))
                {
                    auto* enum_property = static_cast<FEnumProperty*>(property);
                    object_path(enum_property->GetEnum(), json, "enum");
                    nested("underlying", enum_property->GetUnderlyingProp(), json);
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FMapProperty))
                {
                    auto* map_property = static_cast<FMapProperty*>(property);
                    nested("key", map_property->GetKeyProp(), json);
                    nested("value", map_property->GetValueProp(), json);
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FSetProperty))
                {
                    nested("element", static_cast<FSetProperty*>(property)->GetElementProp(), json);
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FByteProperty))
                {
                    object_path(static_cast<FByteProperty*>(property)->GetEnum(), json, "enum");
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FClassProperty))
                {
                    auto* class_property = static_cast<FClassProperty*>(property);
                    object_path(class_property->GetPropertyClass(), json, "class");
                    if (FClassProperty::MemberOffsets.contains(STR("MetaClass")))
                    {
                        object_path(class_property->GetMetaClass(), json, "meta_class");
                    }
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FSoftClassProperty))
                {
                    auto* soft_class_property = static_cast<FSoftClassProperty*>(property);
                    object_path(soft_class_property->GetPropertyClass(), json, "class");
                    if (FSoftClassProperty::MemberOffsets.contains(STR("MetaClass")))
                    {
                        object_path(soft_class_property->GetMetaClass(), json, "meta_class");
                    }
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FObjectProperty | CASTCLASS_FSoftObjectProperty | CASTCLASS_FWeakObjectProperty |
                                                        CASTCLASS_FLazyObjectProperty))
                {
                    object_path(static_cast<FObjectPropertyBase*>(property)->GetPropertyClass(), json, "class");
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FInterfaceProperty))
                {
                    object_path(static_cast<FInterfaceProperty*>(property)->GetInterfaceClass(), json, "interface");
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FMulticastDelegateProperty | CASTCLASS_FMulticastInlineDelegateProperty |
                                                        CASTCLASS_FMulticastSparseDelegateProperty))
                {
                    object_path(static_cast<FMulticastDelegateProperty*>(property)->GetSignatureFunction(), json, "signature");
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FDelegateProperty))
                {
                    object_path(static_cast<FDelegateProperty*>(property)->GetSignatureFunction(), json, "signature");
                }
                else if (property_class.HasAnyCastFlags(CASTCLASS_FOptionalProperty))
                {
                    nested("inner", static_cast<FOptionalProperty*>(property)->GetValueProperty(), json);
                }
                json.end_object();
            }

            // Writes the "properties" array of a struct. A property that cannot be read is
            // counted and left out, so one bad member does not cost the whole type.
            auto properties(UStruct* ustruct, JsonWriter& json) -> void
            {
                // Collected first: a failure half way through a property would otherwise
                // leave an unfinished object in the output stream.
                std::vector<FProperty*> list{};
                for (FProperty* property : TFieldRange<FProperty>(ustruct, EFieldIterationFlags::IncludeDeprecated))
                {
                    list.push_back(property);
                }
                json.key("properties");
                json.begin_array();
                for (FProperty* each : list)
                {
                    if (readable(each))
                    {
                        property(each, json);
                    }
                    else
                    {
                        ++skipped_properties;
                    }
                }
                json.end_array();
            }

            // Writes a function's "parameters" (in call order, the return value included) and
            // its "locals", the other properties a Blueprint function keeps on its frame.
            auto parameters(UFunction* function, JsonWriter& json) -> void
            {
                std::vector<FProperty*> params{};
                std::vector<FProperty*> locals{};
                for (FProperty* each : TFieldRange<FProperty>(function, EFieldIterationFlags::IncludeDeprecated))
                {
                    if (!readable(each))
                    {
                        ++skipped_properties;
                        continue;
                    }
                    bool is_param = (static_cast<uint64_t>(each->GetPropertyFlags()) & CPF_Parm) != 0;
                    (is_param ? params : locals).push_back(each);
                }
                json.key("parameters");
                json.begin_array();
                for (FProperty* each : params)
                {
                    property(each, json, true);
                }
                json.end_array();
                json.key("locals");
                json.begin_array();
                for (FProperty* each : locals)
                {
                    property(each, json);
                }
                json.end_array();
            }

            size_t skipped_properties{};

          private:
            auto nested(std::string_view key, FProperty* inner, JsonWriter& json) -> void
            {
                json.key(key);
                if (inner && readable(inner))
                {
                    property(inner, json);
                }
                else
                {
                    json.null();
                }
            }

            // Writes the property to a writer that discards everything. Every accessor the
            // real output uses runs once, so a member this engine version lacks is found
            // before anything reaches the file.
            auto readable(FProperty* candidate) -> bool
            {
                try
                {
                    m_dry.reset();
                    property(candidate, m_dry);
                    return true;
                }
                catch (...)
                {
                    return false;
                }
            }

            JsonWriter m_dry{JsonWriter::Discard{}};
            PathCache& m_paths;
        };

        auto outermost_path(PathCache& paths, UObject* object) -> std::string
        {
            UObject* current = object;
            while (UObject* outer = current->GetOuterPrivate())
            {
                current = outer;
            }
            return paths.path_of(current);
        }

        auto is_parameter(uint64_t flags) -> bool
        {
            return (flags & CPF_Parm) != 0;
        }

        // Whether a struct has Blueprint bytecode.
        auto script_size(UStruct* ustruct) -> int64_t
        {
            auto& script = ustruct->GetScript();
            return static_cast<int64_t>(script.Num());
        }
    } // namespace

    auto dump_reflection(const std::filesystem::path& dir) -> void
    {
        fs_make_dirs(dir);
        PathCache paths{};
        ReflectionWriter writer{paths};
        MainModule main_module{};

        JsonWriter classes{dir / "classes.json"};
        JsonWriter structs{dir / "structs.json"};
        JsonWriter enums{dir / "enums.json"};
        JsonWriter functions{dir / "functions.json"};

        auto open = [](JsonWriter& json, const char* schema, const char* list) {
            json.begin_object();
            json.field("schema", schema);
            json.key(list);
            json.begin_array(true);
        };
        open(classes, "gmfdumper.classes/1", "classes");
        open(structs, "gmfdumper.structs/1", "structs");
        open(enums, "gmfdumper.enums/1", "enums");
        open(functions, "gmfdumper.functions/1", "functions");

        size_t class_count{}, struct_count{}, enum_count{}, function_count{}, failed{};

        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || *reinterpret_cast<uint64_t*>(object) == 0)
            {
                return LoopAction::Continue;
            }
            UClass* object_class = object->GetClassPrivate();
            if (!object_class || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            uint64_t cast_flags = object_class->GetClassCastFlags();
            if ((cast_flags & (CASTCLASS_UClass | CASTCLASS_UScriptStruct | CASTCLASS_UEnum | CASTCLASS_UFunction)) == 0)
            {
                return LoopAction::Continue;
            }

            // Everything that can throw on an engine member this version lacks is read
            // before the first write, so a failure leaves no partial entry behind.
            try
            {
                const std::string& path = paths.path_of(object);
                std::string name = name_to_utf8(object->GetNamePrivate());
                std::string package = outermost_path(paths, object);

                if ((cast_flags & CASTCLASS_UClass) != 0)
                {
                    auto* uclass = static_cast<UClass*>(object);
                    UStruct* super = uclass->GetSuperStruct();
                    auto flags = static_cast<uint64_t>(static_cast<uint32_t>(uclass->GetClassFlags()));
                    int64_t size = uclass->GetPropertiesSize();
                    int64_t alignment = uclass->GetMinAlignment();
                    UObject* cdo = uclass->GetClassDefaultObject();
                    std::vector<std::string> interfaces{};
                    for (auto& implemented : uclass->GetInterfaces())
                    {
                        if (implemented.Class)
                        {
                            interfaces.push_back(paths.path_of(implemented.Class));
                        }
                    }

                    classes.begin_object();
                    classes.field("path", path);
                    classes.field("name", name);
                    classes.field("package", package);
                    writer.object_path(super, classes, "super");
                    classes.field("native", (flags & CLASS_Native) != 0);
                    classes.field("flags", flags);
                    classes.string_array("flag_names", Flags::names(flags, Flags::s_class_flag_defs));
                    classes.field("size", size);
                    classes.field("alignment", alignment);
                    writer.object_path(cdo, classes, "default_object");
                    classes.string_array("interfaces", interfaces);
                    writer.properties(uclass, classes);
                    classes.end_object();
                    ++class_count;
                }
                else if ((cast_flags & CASTCLASS_UFunction) != 0)
                {
                    auto* ufunction = static_cast<UFunction*>(object);
                    auto flags = static_cast<uint64_t>(ufunction->GetFunctionFlags());
                    auto address = reinterpret_cast<uint64_t>(ufunction->GetFuncPtr());
                    int64_t params_size = ufunction->GetPropertiesSize();
                    int64_t bytecode = script_size(ufunction);
                    UObject* owner = ufunction->GetOuterPrivate();
                    UStruct* super = ufunction->GetSuperStruct();

                    functions.begin_object();
                    functions.field("path", path);
                    functions.field("name", name);
                    functions.field("package", package);
                    writer.object_path(owner, functions, "owner");
                    writer.object_path(super, functions, "super");
                    functions.field("native", (flags & FUNC_Native) != 0);
                    functions.field("flags", flags);
                    functions.string_array("flag_names", Flags::names(flags, Flags::s_function_flag_defs));
                    if (address != 0 && main_module.contains(address))
                    {
                        functions.field("native_offset", hex(address - main_module.base));
                    }
                    else
                    {
                        functions.null_field("native_offset");
                    }
                    functions.field("has_bytecode", bytecode > 0);
                    functions.field("bytecode_size", bytecode);
                    functions.field("params_size", params_size);
                    writer.parameters(ufunction, functions);
                    functions.end_object();
                    ++function_count;
                }
                else if ((cast_flags & CASTCLASS_UScriptStruct) != 0)
                {
                    auto* ustruct = static_cast<UScriptStruct*>(object);
                    UStruct* super = ustruct->GetSuperStruct();
                    auto flags = static_cast<uint64_t>(static_cast<uint32_t>(ustruct->GetStructFlags()));
                    int64_t size = ustruct->GetPropertiesSize();
                    int64_t alignment = ustruct->GetMinAlignment();

                    structs.begin_object();
                    structs.field("path", path);
                    structs.field("name", name);
                    structs.field("package", package);
                    writer.object_path(super, structs, "super");
                    structs.field("native", (flags & STRUCT_Native) != 0);
                    structs.field("flags", flags);
                    structs.string_array("flag_names", Flags::names(flags, Flags::s_struct_flag_defs));
                    structs.field("size", size);
                    structs.field("alignment", alignment);
                    writer.properties(ustruct, structs);
                    structs.end_object();
                    ++struct_count;
                }
                else
                {
                    auto* uenum = static_cast<UEnum*>(object);
                    std::vector<std::pair<std::string, int64_t>> entries{};
                    for (auto& [entry_name, entry_value] : uenum->ForEachName())
                    {
                        entries.emplace_back(name_to_utf8(entry_name), static_cast<int64_t>(entry_value));
                    }
                    const char* form = "Regular";
                    switch (uenum->GetCppForm())
                    {
                    case UEnum::ECppForm::Regular:
                        form = "Regular";
                        break;
                    case UEnum::ECppForm::Namespaced:
                        form = "Namespaced";
                        break;
                    case UEnum::ECppForm::EnumClass:
                        form = "EnumClass";
                        break;
                    }

                    enums.begin_object();
                    enums.field("path", path);
                    enums.field("name", name);
                    enums.field("package", package);
                    enums.field("form", form);
                    if (Version::IsAtLeast(4, 26))
                    {
                        auto flags = static_cast<uint64_t>(static_cast<uint8_t>(uenum->GetEnumFlags()));
                        enums.field("flags", flags);
                        enums.string_array("flag_names", Flags::names(flags, Flags::s_enum_flag_defs));
                    }
                    enums.key("entries");
                    enums.begin_array();
                    for (const auto& [entry_name, entry_value] : entries)
                    {
                        enums.begin_object();
                        enums.field("name", entry_name);
                        enums.field("value", entry_value);
                        enums.end_object();
                    }
                    enums.end_array();
                    enums.end_object();
                    ++enum_count;
                }
            }
            catch (...)
            {
                ++failed;
            }
            return LoopAction::Continue;
        });

        auto finish = [&](JsonWriter& json, size_t count) {
            json.end_array();
            json.field("count", static_cast<uint64_t>(count));
            json.end_object();
            json.close();
        };
        finish(classes, class_count);
        finish(structs, struct_count);
        finish(enums, enum_count);
        finish(functions, function_count);

        Output::send(STR("[GmfDumper] reflection: {} classes, {} structs, {} enums, {} functions, {} objects skipped, {} properties skipped\n"),
                     class_count,
                     struct_count,
                     enum_count,
                     function_count,
                     failed,
                     writer.skipped_properties);
    }

    auto dump_hooks(const std::filesystem::path& dir) -> void
    {
        fs_make_dirs(dir);
        PathCache paths{};
        JsonWriter json{dir / "hookable_functions.json"};
        json.begin_object();
        json.field("schema", "gmfdumper.hookable_functions/1");
        json.field("usage", "pass \"hook\" to RegisterHook(name, callback) in a UE4SS Lua mod");
        json.key("functions");
        json.begin_array(true);

        // RegisterHook accepts exactly two kinds of function (UE4SS LuaMod.cpp): a native one
        // whose function pointer is not the bytecode interpreter, and a non-native one whose
        // function pointer is the bytecode interpreter. Everything else, such as a delegate
        // signature with no function pointer, makes RegisterHook raise an error.
        const auto interpreter = reinterpret_cast<uint64_t>(UObject::ProcessInternalInternal.get_function_address());

        size_t count{};
        size_t not_hookable{};
        UObjectGlobals::ForEachUObject([&](UObject* object, int32, int32) {
            if (!object || *reinterpret_cast<uint64_t*>(object) == 0)
            {
                return LoopAction::Continue;
            }
            UClass* object_class = object->GetClassPrivate();
            if (!object_class || (object_class->GetClassCastFlags() & CASTCLASS_UFunction) == 0 || is_default_object(object))
            {
                return LoopAction::Continue;
            }
            try
            {
                auto* ufunction = static_cast<UFunction*>(object);
                const std::string& path = paths.path_of(object);
                auto flags = static_cast<uint64_t>(ufunction->GetFunctionFlags());
                bool native = (flags & FUNC_Native) != 0;
                auto function_pointer = reinterpret_cast<uint64_t>(ufunction->GetFuncPtr());
                bool hookable = function_pointer != 0 && (native ? function_pointer != interpreter : function_pointer == interpreter);
                if (!hookable)
                {
                    ++not_hookable;
                    return LoopAction::Continue;
                }
                int64_t parameters{};
                bool has_return{};
                for (FProperty* property : TFieldRange<FProperty>(ufunction, EFieldIterationFlags::IncludeDeprecated))
                {
                    auto property_flags = static_cast<uint64_t>(property->GetPropertyFlags());
                    if (is_parameter(property_flags))
                    {
                        if ((property_flags & CPF_ReturnParm) != 0)
                        {
                            has_return = true;
                        }
                        else
                        {
                            ++parameters;
                        }
                    }
                }

                json.begin_object();
                json.field("hook", path);
                // UE4SS hooks a native function at its function pointer, with a pre and a
                // post callback. A Blueprint function runs as bytecode, is caught through
                // UE4SS's script hooks, and its callback acts as a post hook.
                // A delegate signature describes the parameters of an event dispatcher. It
                // passes the same test as a Blueprint function, so RegisterHook accepts it,
                // but nothing ever calls it: the UE4SS documentation lists delegate
                // functions as unsupported. It is listed, marked, so that nobody hooks one
                // and waits for a callback that cannot come.
                const bool delegate_signature = (flags & FUNC_Delegate) != 0;
                json.field("kind", delegate_signature ? "delegate" : native ? "native" : "blueprint");
                json.field("route",
                           delegate_signature ? "delegate signature; RegisterHook accepts it but it is never called. Hook the function that is bound to the delegate"
                           : native           ? "native function pointer; pre and post callbacks"
                                              : "script hook; needs HookProcessInternal and HookProcessLocalScriptFunction = 1; callback runs after the function");
                json.field("parameters", parameters);
                json.field("has_return", has_return);
                json.field("event", (flags & (FUNC_Event | FUNC_BlueprintEvent)) != 0);
                json.field("net", (flags & FUNC_Net) != 0);
                json.field("flags", flags);
                json.string_array("flag_names", Flags::names(flags, Flags::s_function_flag_defs));
                json.end_object();
                ++count;
            }
            catch (...)
            {
            }
            return LoopAction::Continue;
        });

        json.end_array();
        json.field("count", static_cast<uint64_t>(count));
        json.field("not_hookable_count", static_cast<uint64_t>(not_hookable));
        json.end_object();
        json.close();
    }
} // namespace GmfDumper
