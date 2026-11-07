// {{name}} - generated UE4SS C++ mod scaffold.
// Author: {{author}}
#include <Mod/CppUserModBase.hpp>
#include <DynamicOutput/DynamicOutput.hpp>

class {{cppName}} final : public RC::CppUserModBase {
public:
    {{cppName}}() {
        ModName = STR("{{name}}");
        ModVersion = STR("0.1.0");
        ModAuthors = STR("{{author}}");
    }

    ~{{cppName}}() override = default;

    auto on_unreal_init() -> void override {
        RC::Output::send<RC::LogLevel::Verbose>(STR("[{{name}}] loaded\n"));
    }
};

// UE4SS resolves these two exports by name when it loads the DLL.
extern "C" __declspec(dllexport) RC::CppUserModBase* start_mod() {
    return new {{cppName}}();
}

extern "C" __declspec(dllexport) void uninstall_mod(RC::CppUserModBase* mod) {
    delete mod;
}
