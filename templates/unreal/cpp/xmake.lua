-- {{name}} - UE4SS C++ mod.
-- Set UE4SS_INCLUDE and UE4SS_LIB to a UE4SS SDK checkout before building.
-- UE4SS itself builds as C++23 with the dynamic MSVC runtime; the mod must match.
set_languages("cxx23")
set_runtimes("MD")
set_plat("windows")
set_arch("x64")

target("{{cppName}}")
    set_kind("shared")
    add_files("Source/{{name}}/*.cpp")
    add_includedirs(os.getenv("UE4SS_INCLUDE") or "UE4SS/include")
    add_linkdirs(os.getenv("UE4SS_LIB") or "UE4SS/lib")
    add_links("UE4SS")
