#include "GmfCommon.hpp"
#include "Dumpers.hpp"

#include <SDKGenerator/BuiltinSDKBackend.hpp>
#include <SDKGenerator/SDKGenerator.hpp>
#include <UE4SSProgram.hpp>
#include <glaze/glaze.hpp>

// UE4SS's BP SDK generator is reachable only from the "Generate BP SDK" button in its
// window: it has no Lua function and UE4SS.dll does not export it. This mod therefore
// compiles UE4SS's own generator sources (SDKGenerator.cpp and Common.cpp, MIT licensed)
// into this DLL, see native/CMakeLists.txt, and calls it the way the button does.

namespace GmfDumper
{
    namespace
    {
        auto read_backend(const std::string& name) -> UEGenerator::SDKBackendSettings
        {
            static constexpr auto options = glz::opts{
                    .format = glz::JSON,
                    .comments = false,
                    .error_on_unknown_keys = false,
                    .skip_null_members = true,
                    .error_on_missing_keys = false,
            };

            UEGenerator::SDKBackendSettings_ASCII ascii{};
            std::string buffer{};

            // A backend file beside UE4SS wins over the compiled-in one, as in the UE4SS window.
            const auto file = std::filesystem::path{UE4SSProgram::get_program().get_working_directory()} / "UE4SS_SDK_Backends" / (name + ".json");
            std::error_code ec{};
            if (std::filesystem::is_regular_file(file, ec))
            {
                if (auto error = glz::read_file_json<options, UEGenerator::SDKBackendSettings_ASCII>(ascii, file.string(), buffer))
                {
                    throw std::runtime_error{"could not read SDK backend '" + path_to_utf8(file) + "': " + glz::format_error(error, buffer)};
                }
            }
            else if (name == UEGenerator::g_builtin_ue4ss_backend_name)
            {
                buffer = std::string{UEGenerator::g_builtin_ue4ss_backend_json};
                if (auto error = glz::read<options>(ascii, buffer))
                {
                    throw std::runtime_error{"could not read the built-in SDK backend: " + glz::format_error(error, buffer)};
                }
            }
            else
            {
                throw std::runtime_error{"SDK backend not found: " + path_to_utf8(file)};
            }

            UEGenerator::SDKBackendSettings settings{};
            settings.IncludePrefix = to_wstring(ascii.IncludePrefix.value);
            settings.HeaderFileExtension = to_wstring(ascii.HeaderFileExtension.value);
            settings.UnrealImplementationNamespace = to_wstring(ascii.UnrealImplementationNamespace.value);
            settings.SDKNamespace = to_wstring(ascii.SDKNamespace.value);
            for (const auto& type : ascii.ExcludedTypes.value)
            {
                settings.ExcludedTypes.emplace(to_wstring(type));
            }
            for (const auto& [key, value] : ascii.UnreflectedTypes.value)
            {
                settings.UnreflectedTypes.emplace(to_wstring(key), to_wstring(value));
            }
            return settings;
        }
    } // namespace

    auto generate_bp_sdk(const std::filesystem::path& dir, const std::string& backend) -> void
    {
        auto settings = read_backend(backend);
        fs_make_dirs(dir);

        // The generator writes to [SDKGenerator] OutputPath when that setting is filled in.
        // Clear it for this call so the SDK lands in the run folder, then put it back.
        auto& configured_path = UE4SSProgram::settings_manager.SDKGenerator.OutputPath;
        auto saved_path = configured_path;
        configured_path = {};
        try
        {
            UEGenerator::generate_sdk(dir / "UE4SS_SDK", settings);
        }
        catch (...)
        {
            configured_path = saved_path;
            throw;
        }
        configured_path = saved_path;
    }
} // namespace GmfDumper
