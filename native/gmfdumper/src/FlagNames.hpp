#pragma once

// Flag name tables for Unreal object, function, class, property, struct and enum flags.
//
// The tables below are copied from RE-UE4SS, UE4SS/src/JMapGenerator/JMapGenerator.cpp
// (commit 4fb9b615), which is MIT licensed, Copyright (c) the RE-UE4SS contributors.

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace GmfDumper::Flags
{
    struct FlagDef
    {
        const char* name;
        uint64_t bits;
    };

    inline constexpr FlagDef s_object_flag_defs[] = {
            {"RF_Public", 0x0001},
            {"RF_Standalone", 0x0002},
            {"RF_MarkAsNative", 0x0004},
            {"RF_Transactional", 0x0008},
            {"RF_ClassDefaultObject", 0x0010},
            {"RF_ArchetypeObject", 0x0020},
            {"RF_Transient", 0x0040},
            {"RF_MarkAsRootSet", 0x0080},
            {"RF_TagGarbageTemp", 0x0100},
            {"RF_NeedInitialization", 0x0200},
            {"RF_NeedLoad", 0x0400},
            {"RF_KeepForCooker", 0x0800},
            {"RF_NeedPostLoad", 0x1000},
            {"RF_NeedPostLoadSubobjects", 0x2000},
            {"RF_NewerVersionExists", 0x4000},
            {"RF_BeginDestroyed", 0x8000},
            {"RF_FinishDestroyed", 0x00010000},
            {"RF_BeingRegenerated", 0x00020000},
            {"RF_DefaultSubObject", 0x00040000},
            {"RF_WasLoaded", 0x00080000},
            {"RF_TextExportTransient", 0x00100000},
            {"RF_LoadCompleted", 0x00200000},
            {"RF_InheritableComponentTemplate", 0x00400000},
            {"RF_DuplicateTransient", 0x00800000},
            {"RF_StrongRefOnFrame", 0x01000000},
            {"RF_NonPIEDuplicateTransient", 0x02000000},
            {"RF_Dynamic", 0x04000000},
            {"RF_WillBeLoaded", 0x08000000},
    };

    inline constexpr FlagDef s_function_flag_defs[] = {
            {"FUNC_Final", 0x0001},
            {"FUNC_RequiredAPI", 0x0002},
            {"FUNC_BlueprintAuthorityOnly", 0x0004},
            {"FUNC_BlueprintCosmetic", 0x0008},
            {"FUNC_Net", 0x0040},
            {"FUNC_NetReliable", 0x0080},
            {"FUNC_NetRequest", 0x0100},
            {"FUNC_Exec", 0x0200},
            {"FUNC_Native", 0x0400},
            {"FUNC_Event", 0x0800},
            {"FUNC_NetResponse", 0x1000},
            {"FUNC_Static", 0x2000},
            {"FUNC_NetMulticast", 0x4000},
            {"FUNC_UbergraphFunction", 0x8000},
            {"FUNC_MulticastDelegate", 0x00010000},
            {"FUNC_Public", 0x00020000},
            {"FUNC_Private", 0x00040000},
            {"FUNC_Protected", 0x00080000},
            {"FUNC_Delegate", 0x00100000},
            {"FUNC_NetServer", 0x00200000},
            {"FUNC_HasOutParms", 0x00400000},
            {"FUNC_HasDefaults", 0x00800000},
            {"FUNC_NetClient", 0x01000000},
            {"FUNC_DLLImport", 0x02000000},
            {"FUNC_BlueprintCallable", 0x04000000},
            {"FUNC_BlueprintEvent", 0x08000000},
            {"FUNC_BlueprintPure", 0x10000000},
            {"FUNC_EditorOnly", 0x20000000},
            {"FUNC_Const", 0x40000000},
            {"FUNC_NetValidate", 0x80000000},
            {"FUNC_AllFlags", 0xffffffff},
    };

    inline constexpr FlagDef s_class_flag_defs[] = {
            {"CLASS_Abstract", 0x0001},
            {"CLASS_DefaultConfig", 0x0002},
            {"CLASS_Config", 0x0004},
            {"CLASS_Transient", 0x0008},
            {"CLASS_Parsed", 0x0010},
            {"CLASS_MatchedSerializers", 0x0020},
            {"CLASS_ProjectUserConfig", 0x0040},
            {"CLASS_Native", 0x0080},
            {"CLASS_NoExport", 0x0100},
            {"CLASS_NotPlaceable", 0x0200},
            {"CLASS_PerObjectConfig", 0x0400},
            {"CLASS_ReplicationDataIsSetUp", 0x0800},
            {"CLASS_EditInlineNew", 0x1000},
            {"CLASS_CollapseCategories", 0x2000},
            {"CLASS_Interface", 0x4000},
            {"CLASS_CustomConstructor", 0x8000},
            {"CLASS_Const", 0x00010000},
            {"CLASS_LayoutChanging", 0x00020000},
            {"CLASS_CompiledFromBlueprint", 0x00040000},
            {"CLASS_MinimalAPI", 0x00080000},
            {"CLASS_RequiredAPI", 0x00100000},
            {"CLASS_DefaultToInstanced", 0x00200000},
            {"CLASS_TokenStreamAssembled", 0x00400000},
            {"CLASS_HasInstancedReference", 0x00800000},
            {"CLASS_Hidden", 0x01000000},
            {"CLASS_Deprecated", 0x02000000},
            {"CLASS_HideDropDown", 0x04000000},
            {"CLASS_GlobalUserConfig", 0x08000000},
            {"CLASS_Intrinsic", 0x10000000},
            {"CLASS_Constructed", 0x20000000},
            {"CLASS_ConfigDoNotCheckDefaults", 0x40000000},
            {"CLASS_NewerVersionExists", 0x80000000},
    };

    inline constexpr FlagDef s_class_cast_flag_defs[] = {
            {"CASTCLASS_UField", 0x0000000000000001},
            {"CASTCLASS_FInt8Property", 0x0000000000000002},
            {"CASTCLASS_UEnum", 0x0000000000000004},
            {"CASTCLASS_UStruct", 0x0000000000000008},
            {"CASTCLASS_UScriptStruct", 0x0000000000000010},
            {"CASTCLASS_UClass", 0x0000000000000020},
            {"CASTCLASS_FByteProperty", 0x0000000000000040},
            {"CASTCLASS_FIntProperty", 0x0000000000000080},
            {"CASTCLASS_FFloatProperty", 0x0000000000000100},
            {"CASTCLASS_FUInt64Property", 0x0000000000000200},
            {"CASTCLASS_FClassProperty", 0x0000000000000400},
            {"CASTCLASS_FUInt32Property", 0x0000000000000800},
            {"CASTCLASS_FInterfaceProperty", 0x0000000000001000},
            {"CASTCLASS_FNameProperty", 0x0000000000002000},
            {"CASTCLASS_FStrProperty", 0x0000000000004000},
            {"CASTCLASS_FProperty", 0x0000000000008000},
            {"CASTCLASS_FObjectProperty", 0x0000000000010000},
            {"CASTCLASS_FBoolProperty", 0x0000000000020000},
            {"CASTCLASS_FUInt16Property", 0x0000000000040000},
            {"CASTCLASS_UFunction", 0x0000000000080000},
            {"CASTCLASS_FStructProperty", 0x0000000000100000},
            {"CASTCLASS_FArrayProperty", 0x0000000000200000},
            {"CASTCLASS_FInt64Property", 0x0000000000400000},
            {"CASTCLASS_FDelegateProperty", 0x0000000000800000},
            {"CASTCLASS_FNumericProperty", 0x0000000001000000},
            {"CASTCLASS_FMulticastDelegateProperty", 0x0000000002000000},
            {"CASTCLASS_FObjectPropertyBase", 0x0000000004000000},
            {"CASTCLASS_FWeakObjectProperty", 0x0000000008000000},
            {"CASTCLASS_FLazyObjectProperty", 0x0000000010000000},
            {"CASTCLASS_FSoftObjectProperty", 0x0000000020000000},
            {"CASTCLASS_FTextProperty", 0x0000000040000000},
            {"CASTCLASS_FInt16Property", 0x0000000080000000},
            {"CASTCLASS_FDoubleProperty", 0x0000000100000000},
            {"CASTCLASS_FSoftClassProperty", 0x0000000200000000},
            {"CASTCLASS_UPackage", 0x0000000400000000},
            {"CASTCLASS_ULevel", 0x0000000800000000},
            {"CASTCLASS_AActor", 0x0000001000000000},
            {"CASTCLASS_APlayerController", 0x0000002000000000},
            {"CASTCLASS_APawn", 0x0000004000000000},
            {"CASTCLASS_USceneComponent", 0x0000008000000000},
            {"CASTCLASS_UPrimitiveComponent", 0x0000010000000000},
            {"CASTCLASS_USkinnedMeshComponent", 0x0000020000000000},
            {"CASTCLASS_USkeletalMeshComponent", 0x0000040000000000},
            {"CASTCLASS_UBlueprint", 0x0000080000000000},
            {"CASTCLASS_UDelegateFunction", 0x0000100000000000},
            {"CASTCLASS_UStaticMeshComponent", 0x0000200000000000},
            {"CASTCLASS_FMapProperty", 0x0000400000000000},
            {"CASTCLASS_FSetProperty", 0x0000800000000000},
            {"CASTCLASS_FEnumProperty", 0x0001000000000000},
            {"CASTCLASS_USparseDelegateFunction", 0x0002000000000000},
            {"CASTCLASS_FMulticastInlineDelegateProperty", 0x0004000000000000},
            {"CASTCLASS_FMulticastSparseDelegateProperty", 0x0008000000000000},
            {"CASTCLASS_FFieldPathProperty", 0x0010000000000000},
            {"CASTCLASS_FLargeWorldCoordinatesRealProperty", 0x0080000000000000},
            {"CASTCLASS_FOptionalProperty", 0x0100000000000000},
            {"CASTCLASS_FVerseValueProperty", 0x0200000000000000},
            {"CASTCLASS_FVRestValueProperty", 0x0400000000000000},
            {"CASTCLASS_FVerseStringProperty", 0x0800000000000000},
            {"CASTCLASS_FUtf8StrProperty", 0x1000000000000000},
            {"CASTCLASS_FAnsiStrProperty", 0x2000000000000000},
            {"CASTCLASS_FVCellProperty", 0x4000000000000000},
    };

    inline constexpr FlagDef s_property_flag_defs[] = {
            {"CPF_Edit", 0x0001},
            {"CPF_ConstParm", 0x0002},
            {"CPF_BlueprintVisible", 0x0004},
            {"CPF_ExportObject", 0x0008},
            {"CPF_BlueprintReadOnly", 0x0010},
            {"CPF_Net", 0x0020},
            {"CPF_EditFixedSize", 0x0040},
            {"CPF_Parm", 0x0080},
            {"CPF_OutParm", 0x0100},
            {"CPF_ZeroConstructor", 0x0200},
            {"CPF_ReturnParm", 0x0400},
            {"CPF_DisableEditOnTemplate", 0x0800},
            {"CPF_NonNullable", 0x1000},
            {"CPF_Transient", 0x2000},
            {"CPF_Config", 0x4000},
            {"CPF_RequiredParm", 0x8000},
            {"CPF_DisableEditOnInstance", 0x00010000},
            {"CPF_EditConst", 0x00020000},
            {"CPF_GlobalConfig", 0x00040000},
            {"CPF_InstancedReference", 0x00080000},
            {"CPF_ExperimentalExternalObjects", 0x00100000},
            {"CPF_DuplicateTransient", 0x00200000},
            {"CPF_SaveGame", 0x01000000},
            {"CPF_NoClear", 0x02000000},
            {"CPF_Virtual", 0x04000000},
            {"CPF_ReferenceParm", 0x08000000},
            {"CPF_BlueprintAssignable", 0x10000000},
            {"CPF_Deprecated", 0x20000000},
            {"CPF_IsPlainOldData", 0x40000000},
            {"CPF_RepSkip", 0x80000000},
            {"CPF_RepNotify", 0x100000000},
            {"CPF_Interp", 0x200000000},
            {"CPF_NonTransactional", 0x400000000},
            {"CPF_EditorOnly", 0x800000000},
            {"CPF_NoDestructor", 0x1000000000},
            {"CPF_AutoWeak", 0x4000000000},
            {"CPF_ContainsInstancedReference", 0x8000000000},
            {"CPF_AssetRegistrySearchable", 0x10000000000},
            {"CPF_SimpleDisplay", 0x20000000000},
            {"CPF_AdvancedDisplay", 0x40000000000},
            {"CPF_Protected", 0x80000000000},
            {"CPF_BlueprintCallable", 0x100000000000},
            {"CPF_BlueprintAuthorityOnly", 0x200000000000},
            {"CPF_TextExportTransient", 0x400000000000},
            {"CPF_NonPIEDuplicateTransient", 0x800000000000},
            {"CPF_ExposeOnSpawn", 0x1000000000000},
            {"CPF_PersistentInstance", 0x2000000000000},
            {"CPF_UObjectWrapper", 0x4000000000000},
            {"CPF_HasGetValueTypeHash", 0x8000000000000},
            {"CPF_NativeAccessSpecifierPublic", 0x10000000000000},
            {"CPF_NativeAccessSpecifierProtected", 0x20000000000000},
            {"CPF_NativeAccessSpecifierPrivate", 0x40000000000000},
            {"CPF_SkipSerialization", 0x80000000000000},
            {"CPF_TObjectPtr", 0x100000000000000},
            {"CPF_ExperimentalOverridableLogic", 0x200000000000000},
            {"CPF_ExperimentalAlwaysOverriden", 0x400000000000000},
            {"CPF_ExperimentalNeverOverriden", 0x800000000000000},
            {"CPF_AllowSelfReference", 0x1000000000000000},
    };

    inline constexpr FlagDef s_struct_flag_defs[] = {
            {"STRUCT_Native", 0x0001},
            {"STRUCT_IdenticalNative", 0x0002},
            {"STRUCT_HasInstancedReference", 0x0004},
            {"STRUCT_NoExport", 0x0008},
            {"STRUCT_Atomic", 0x0010},
            {"STRUCT_Immutable", 0x0020},
            {"STRUCT_AddStructReferencedObjects", 0x0040},
            {"STRUCT_RequiredAPI", 0x0200},
            {"STRUCT_NetSerializeNative", 0x0400},
            {"STRUCT_SerializeNative", 0x0800},
            {"STRUCT_CopyNative", 0x1000},
            {"STRUCT_IsPlainOldData", 0x2000},
            {"STRUCT_NoDestructor", 0x4000},
            {"STRUCT_ZeroConstructor", 0x8000},
            {"STRUCT_ExportTextItemNative", 0x00010000},
            {"STRUCT_ImportTextItemNative", 0x00020000},
            {"STRUCT_PostSerializeNative", 0x00040000},
            {"STRUCT_SerializeFromMismatchedTag", 0x00080000},
            {"STRUCT_NetDeltaSerializeNative", 0x00100000},
            {"STRUCT_PostScriptConstruct", 0x00200000},
            {"STRUCT_NetSharedSerialization", 0x00400000},
            {"STRUCT_Trashed", 0x00800000},
            {"STRUCT_Inherit", 0x0014},
            {"STRUCT_ComputedFlags", 0x007ffc42},
    };

    inline constexpr FlagDef s_enum_flag_defs[] = {
            {"Flags", 0x00000001},
            {"NewerVersionExists", 0x00000002},
    };

    // Names of the flags set in `bits`, in table order. Bits no table entry covers are
    // appended as one hexadecimal string.
    template <size_t N>
    auto names(uint64_t bits, const FlagDef (&defs)[N]) -> std::vector<std::string>
    {
        std::vector<std::string> out{};
        uint64_t remaining = bits;
        for (const auto& def : defs)
        {
            if (def.bits != 0 && (bits & def.bits) == def.bits && (remaining & def.bits) != 0)
            {
                out.emplace_back(def.name);
                remaining &= ~def.bits;
            }
        }
        if (remaining != 0)
        {
            char buffer[32];
            std::snprintf(buffer, sizeof(buffer), "0x%llX", static_cast<unsigned long long>(remaining));
            out.emplace_back(buffer);
        }
        return out;
    }
} // namespace GmfDumper::Flags
